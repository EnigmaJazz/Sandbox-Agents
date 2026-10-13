import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advisorSocketPath } from "../src/advisor-socket.ts";
import { defaultConfig } from "../src/config.ts";
import { BrokerServer, raceProbeTimeout } from "../src/server.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(advisorProjects: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "server-socket-lifecycle-"));
  roots.push(root);
  const projectPath = join(root, "repo");
  mkdirSync(projectPath);
  const socketPath = join(root, "broker.sock");
  const server = new BrokerServer(defaultConfig({
    stateDir: join(root, "state"),
    socketPath,
    projects: [{ id: "repo", path: projectPath }],
    advisorProjects,
  }));
  return { root, socketPath, server };
}

async function requestMetrics(socketPath: string): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let rx = "";
    const timer = setTimeout(() => reject(new Error("broker did not answer metrics request")), 2_000);
    void Bun.connect({
      unix: socketPath,
      socket: {
        data(socket, data) {
          rx += data.toString("utf8");
          const newline = rx.indexOf("\n");
          if (newline === -1) return;
          clearTimeout(timer);
          socket.end();
          resolve(JSON.parse(rx.slice(0, newline)));
        },
        error(_socket, error) {
          clearTimeout(timer);
          reject(error);
        },
      },
    }).then((socket) => {
      socket.write(`${JSON.stringify({ version: 1, id: "metrics", operation: "metrics", sessionID: "socket-test" })}\n`);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("BrokerServer socket lifecycle", () => {
  test("bounds a probe that never settles", async () => {
    expect(await raceProbeTimeout(new Promise(() => {}), 1)).toBe("probe-timeout");
  });

  test("clears the timeout when a probe settles first", async () => {
    expect(await raceProbeTimeout(Promise.resolve("connected"), 5_000)).toBe("connected");
  });

  test("recovers a socket file left by a stopped listener and binds with mode 0600", async () => {
    const { socketPath, server } = setup();
    const child = Bun.spawn([
      process.execPath,
      "-e",
      "await Bun.listen({ unix: process.argv[1], socket: { data() {} } }); console.log('ready'); process.exit(0);",
      socketPath,
    ], { stdout: "pipe", stderr: "pipe" });
    await child.stdout.getReader().read();
    expect(await child.exited).toBe(0);
    expect(lstatSync(socketPath).isSocket()).toBe(true);

    try {
      await server.start();
      expect(lstatSync(socketPath).isSocket()).toBe(true);
      expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    } finally {
      server.shutdown();
    }
  });

  test("refuses to steal a live broker socket and leaves the first broker serving", async () => {
    const { socketPath, server: first } = setup();
    const second = new BrokerServer(defaultConfig({ stateDir: join(roots[0]!, "state-2"), socketPath }));
    await first.start();
    try {
      await expect(second.start()).rejects.toMatchObject({ code: "SOCKET_IN_USE", reason: "connected" });
      second.shutdown();
      expect(existsSync(socketPath)).toBe(true);
      expect(await requestMetrics(socketPath)).toMatchObject({ id: "metrics", ok: true });
    } finally {
      second.shutdown();
      first.shutdown();
    }
  });

  test("shutdown removes main and advisor socket files", async () => {
    const { socketPath, server } = setup(["repo"]);
    const advisorPath = advisorSocketPath(socketPath, "repo");
    await server.start();
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(advisorPath)).toBe(true);

    server.shutdown();
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(advisorPath)).toBe(false);
  });

  test("refuses an existing non-socket path without deleting it", async () => {
    const { socketPath, server } = setup();
    writeFileSync(socketPath, "not a socket");

    try {
      await expect(server.start()).rejects.toThrow("not a socket");
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      server.shutdown();
    }
  });
});
