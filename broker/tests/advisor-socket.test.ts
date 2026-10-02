/**
 * External advisors A1 (odd/tasks/external-advisors.md): a per-project advisor
 * socket whose connections are each bound to one broker-assigned session,
 * restricted to worker operations, with the project fixed by the listener.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADVISOR_AGENT,
  ADVISOR_ALLOWED_OPERATIONS,
  advisorSocketPath,
  bindAdvisorRequest,
  newAdvisorSessionID,
  refuseAdvisorSessionOnMain,
  type AdvisorBinding,
} from "../src/advisor-socket.ts";
import { defaultConfig } from "../src/config.ts";
import { PolicyError } from "../src/policy.ts";
import { BrokerServer } from "../src/server.ts";
import { OPERATIONS, type BrokerRequestEnvelope } from "../src/types.ts";
import { ValidationError } from "../src/validation.ts";

const binding: AdvisorBinding = {
  projectId: "repo",
  projectPath: "/home/james/repo",
  sessionID: "advisor-repo-0123456789abcdef",
};

function req(operation: string, sessionID = "advisor", payload?: Record<string, unknown>, agent?: string): BrokerRequestEnvelope {
  return { version: 1, id: "r1", operation, sessionID, ...(agent ? { agent } : {}), ...(payload ? { payload } : {}) } as BrokerRequestEnvelope;
}

describe("advisor socket naming and sessions", () => {
  test("the socket sits next to the main socket, named by project", () => {
    expect(advisorSocketPath("/run/user/1000/opencode-sandbox-broker.sock", "repo")).toBe(
      "/run/user/1000/opencode-sandbox-advisor-repo.sock",
    );
  });

  test("an unsafe project id is refused", () => {
    for (const bad of ["../x", "a/b", "", "x".repeat(65), "has space"]) {
      expect(() => advisorSocketPath("/run/user/1000/b.sock", bad)).toThrow(ValidationError);
    }
  });

  test("assigned sessions are advisor-<project>-<random>, distinct, and valid broker session ids", () => {
    const a = newAdvisorSessionID("repo");
    const b = newAdvisorSessionID("repo");
    expect(a).toMatch(/^advisor-repo-[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(64);
  });
});

describe("advisor request binding", () => {
  test("the allowlist is exactly the worker operations", () => {
    expect([...ADVISOR_ALLOWED_OPERATIONS].sort()).toEqual(
      ["advisorRead", "advisorRespond", "applyPatch", "destroyWorker", "diff", "ensureWorker", "exec", "grep", "listDir", "readFile", "workerStatus", "writeFile"],
    );
  });

  test("every other broker operation is refused", () => {
    const refused = OPERATIONS.filter((op) => !ADVISOR_ALLOWED_OPERATIONS.has(op));
    expect(refused).toContain("applyResult");
    expect(refused).toContain("prepareResult");
    expect(refused).toContain("copyOut");
    expect(refused).toContain("reviewCaptureResult");
    expect(refused).toContain("bindSessionAgent");
    for (const op of refused) {
      expect(() => bindAdvisorRequest(req(op), binding)).toThrow(PolicyError);
    }
  });

  test("an allowed request is rewritten to the bound session and the advisor agent", () => {
    const bound = bindAdvisorRequest(req("exec", "advisor", { argv: ["pwd"] }, "gentle-orchestrator"), binding);
    expect(bound.sessionID).toBe(binding.sessionID);
    expect(bound.agent).toBe(ADVISOR_AGENT);
    expect(bound.payload).toEqual({ argv: ["pwd"] });
  });

  test("the bound session id itself is also accepted", () => {
    expect(bindAdvisorRequest(req("workerStatus", binding.sessionID), binding).sessionID).toBe(binding.sessionID);
  });

  test("naming any other session is refused", () => {
    for (const other of ["ses_abc", "advisor-repo-ffffffffffffffff", "advisor-other-0123456789abcdef"]) {
      expect(() => bindAdvisorRequest(req("workerStatus", other), binding)).toThrow(PolicyError);
    }
  });

  test("ensureWorker is pinned to the listener's project", () => {
    expect(bindAdvisorRequest(req("ensureWorker"), binding).payload).toEqual({ projectDir: binding.projectPath });
    expect(bindAdvisorRequest(req("ensureWorker", "advisor", { projectDir: binding.projectPath }), binding).payload).toEqual({
      projectDir: binding.projectPath,
    });
    expect(() => bindAdvisorRequest(req("ensureWorker", "advisor", { projectDir: "/home/james/other" }), binding)).toThrow(PolicyError);
  });

  test("the main socket refuses advisor sessions and passes everything else", () => {
    expect(() => refuseAdvisorSessionOnMain(req("workerStatus", "advisor-repo-0123456789abcdef"))).toThrow(PolicyError);
    expect(() => refuseAdvisorSessionOnMain(req("workerStatus", "advisor"))).toThrow(PolicyError);
    expect(refuseAdvisorSessionOnMain(req("workerStatus", "ses_abc")).sessionID).toBe("ses_abc");
  });
});

/** Raw NDJSON connection: send frames, collect replies by id. */
async function connect(socketPath: string) {
  const replies = new Map<string, { ok: boolean; result?: unknown; error?: { message: string } }>();
  let rx = "";
  const sock = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, data) {
        rx += data.toString("utf8");
        let nl: number;
        while ((nl = rx.indexOf("\n")) !== -1) {
          const reply = JSON.parse(rx.slice(0, nl));
          replies.set(reply.id, reply);
          rx = rx.slice(nl + 1);
        }
      },
    },
  });
  return {
    async ask(id: string, operation: string, sessionID: string, payload?: unknown, agent?: string) {
      sock.write(`${JSON.stringify({ version: 1, id, operation, sessionID, ...(agent ? { agent } : {}), ...(payload ? { payload } : {}) })}\n`);
      for (let i = 0; i < 200 && !replies.has(id); i++) await Bun.sleep(10);
      return replies.get(id);
    },
    close() { sock.end(); },
  };
}

describe("BrokerServer advisor listener", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("binds each connection to its own session, refuses the rest, and stays 0600", async () => {
    const root = mkdtempSync(join(tmpdir(), "advisor-socket-"));
    roots.push(root);
    const projectPath = join(root, "repo");
    mkdirSync(projectPath);
    const socketPath = join(root, "broker.sock");
    const config = defaultConfig({
      stateDir: join(root, "state"),
      socketPath,
      projects: [{ id: "repo", path: projectPath }],
      advisorProjects: ["repo"],
    });
    const server = new BrokerServer(config);
    await server.start();
    const advisorPath = advisorSocketPath(socketPath, "repo");
    const one = await connect(advisorPath);
    const two = await connect(advisorPath);
    const main = await connect(socketPath);
    try {
      expect(statSync(advisorPath).mode & 0o777).toBe(0o600);

      // The broker rewrites the session: an unknown-session error names the assigned one.
      const s1 = await one.ask("a", "workerStatus", "advisor");
      const s2 = await two.ask("b", "workerStatus", "advisor");
      const name1 = /advisor-repo-[0-9a-f]{16}/.exec(s1?.error?.message ?? "")?.[0];
      const name2 = /advisor-repo-[0-9a-f]{16}/.exec(s2?.error?.message ?? "")?.[0];
      expect(name1).toBeDefined();
      expect(name2).toBeDefined();
      expect(name1).not.toBe(name2);

      // Operations outside the allowlist, foreign sessions, and another project are refused.
      expect((await one.ask("c", "prepareResult", "advisor"))?.error?.message).toContain("not available on the advisor socket");
      expect((await one.ask("d", "workerStatus", name2!))?.error?.message).toContain("only its own session");
      expect((await one.ask("e", "ensureWorker", "advisor", { projectDir: "/elsewhere" }))?.error?.message).toContain("pinned");

      // The main socket cannot operate an advisor session.
      expect((await main.ask("f", "workerStatus", name1!))?.error?.message).toContain("advisor socket");
    } finally {
      one.close();
      two.close();
      main.close();
      server.shutdown();
    }
  }, 20_000);

  test("end to end: the orchestrator asks, an advisor claims and answers, the orchestrator reads it", async () => {
    const root = mkdtempSync(join(tmpdir(), "advisor-socket-"));
    roots.push(root);
    const projectPath = join(root, "repo");
    mkdirSync(projectPath);
    const socketPath = join(root, "broker.sock");
    const config = defaultConfig({
      stateDir: join(root, "state"),
      socketPath,
      projects: [{ id: "repo", path: projectPath }],
      advisorProjects: ["repo"],
      readOnlyAgents: ["gentle-orchestrator"],
    });
    const server = new BrokerServer(config);
    await server.start();
    const main = await connect(socketPath);
    const advisor = await connect(advisorSocketPath(socketPath, "repo"));
    try {
      const sendAs = async (conn: typeof main, id: string, operation: string, sessionID: string, payload?: unknown, agent?: string) => {
        return conn.ask(id, operation, sessionID, payload, agent);
      };
      // Host-authoritative orchestrator binding, as the plugin's chat.params hook does.
      expect((await sendAs(main, "bind", "bindSessionAgent", "ses_orch", { agent: "gentle-orchestrator" }))?.ok).toBe(true);
      const asked = await sendAs(main, "ask", "advisorAsk", "ses_orch", {
        projectDir: projectPath,
        kind: "pre-code-advice",
        binding: { task: "odd/tasks/feature-x.md#T1", step: "pre-code" },
        snapshot: { worktree: true },
        host: "rotate",
        selection: { rule: "default-rotate" },
        question: "Anything missing?",
      });
      expect(asked?.ok).toBe(true);
      const requestId = (asked as unknown as { result: { id: string } }).result.id;

      expect((await sendAs(main, "steal", "advisorRead", "ses_orch", { id: requestId }))?.error?.message).toContain("only on an advisor socket");
      const read = await sendAs(advisor, "read", "advisorRead", "advisor", { id: requestId });
      expect(read?.ok).toBe(true);
      const answered = await sendAs(advisor, "answer", "advisorRespond", "advisor", { id: requestId, status: "submitted", verdict: "Add a rollback step." });
      expect(answered?.ok).toBe(true);
      expect((await sendAs(advisor, "again", "advisorRespond", "advisor", { id: requestId, status: "submitted", verdict: "x" }))?.error?.message).toContain("already");

      const got = await sendAs(main, "get", "advisorGet", "ses_orch", { projectDir: projectPath, id: requestId });
      expect((got as unknown as { result: { status: string; response: { verdict: string } } }).result).toMatchObject({
        status: "submitted",
        response: { verdict: "Add a rollback step." },
      });
    } finally {
      main.close();
      advisor.close();
      server.shutdown();
    }
  }, 20_000);

  test("an advisor project that is not registered is refused at start", async () => {
    const root = mkdtempSync(join(tmpdir(), "advisor-socket-"));
    roots.push(root);
    const config = defaultConfig({
      stateDir: join(root, "state"),
      socketPath: join(root, "broker.sock"),
      projects: [],
      advisorProjects: ["repo"],
    });
    const server = new BrokerServer(config);
    await expect(server.start()).rejects.toThrow("not a registered project");
    server.shutdown();
  });
});
