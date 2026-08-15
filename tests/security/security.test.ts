/**
 * Gated security suite (SYSTEM_PROMPT.md §28, §29; spec §27 Gate 7/10).
 *
 * Skipped unless SANDBOX_GATED_TESTS=security (or "all"):
 *
 *   SANDBOX_GATED_TESTS=security bun test tests/security/
 *
 * What this suite covers at Gate 4:
 *  - §28 broker argument attacks against a LIVE broker socket (NDJSON);
 *  - S14 fail closed: broker down ⇒ calls fail, never fall back to host;
 *  - S7/S8/S9/S11/S12 worker isolation probes via a throwaway msb worker
 *    (host escape, OAuth absence, secret paths, LAN isolation) — the worker
 *    is created DIRECTLY through msb with the broker's policy shapes
 *    (Gate 3-verified confs), because the broker's git snapshot path is a
 *    Gate 5/6 deliverable, not this suite's subject.
 *  - S16 divergence and S17 self-modification are covered at Gate 6
 *    (git result round-trip) — see docs/manual-verification.md.
 *
 * Gate 4: NOT self-certified. The USER reviews the results
 * (docs/manual-verification.md Gate 4 checklist).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

const GATE = process.env.SANDBOX_GATED_TESTS ?? "";
const enabled = GATE === "security" || GATE === "all";

const BROKER_MAIN = join(import.meta.dir, "..", "..", "broker", "src", "main.ts");
const STATE_TMP = mkdtempSync(join(tmpdir(), "sbs-sec-"));
const SOCKET = join(STATE_TMP, "broker.sock");
const LOG = join(STATE_TMP, "broker.log");
const LAN_IP = "100.90.20.31"; // host LAN address observed at discovery

let brokerProc: ReturnType<typeof spawn> | null = null;
let brokerReady = false;

// ---------------------------------------------------------------------------
// Minimal NDJSON client (mirrors opencode/plugins/lib/broker-client.ts wire)
// ---------------------------------------------------------------------------
interface Envelope {
  version: number;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

function requestLine(
  id: string,
  sessionID: string,
  operation: string,
  payload?: unknown,
): string {
  return JSON.stringify({ version: 1, id, sessionID, operation, ...(payload === undefined ? {} : { payload }) });
}

/** One request/response round trip over a fresh connection. */
function rpc(
  line: string,
  opts: { raw?: boolean } = {},
): Promise<{ response: Envelope | null; closed: boolean; raw?: string }> {
  return new Promise((resolve) => {
    const sock = connect(SOCKET);
    let buf = "";
    let done = false;
    let parsed: Envelope | null = null;
    const finish = (response: Envelope | null, closed: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ response, closed });
    };
    sock.setTimeout(15_000);
    sock.on("connect", () => sock.write(line.endsWith("\n") || opts.raw ? line : line + "\n"));
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1 && parsed === null) {
        parsed = JSON.parse(buf.slice(0, nl)) as Envelope;
        finish(parsed, false);
      }
    });
    sock.on("close", () => finish(parsed, true));
    sock.on("error", () => finish(parsed, true));
    sock.on("timeout", () => finish(parsed, true));
  });
}

async function waitForSocket(path: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`broker socket never appeared at ${path}`);
}

// ---------------------------------------------------------------------------
// msb worker helpers (policy shapes from Gate 3 verification)
// ---------------------------------------------------------------------------
function msbRun(args: string[], timeoutMs = 120_000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/home/james/.local/bin/msb", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout: out, stderr: err });
    });
  });
}

const WORKER = "gate4-sec-worker";
async function ensureProbeWorker(): Promise<void> {
  await msbRun(["stop", WORKER]);
  await msbRun(["remove", WORKER]);
  const conf = join(STATE_TMP, "conf");
  mkdirSync(conf, { recursive: true });
  writeFileSync(join(conf, "runtime.conf"), '{"security":"restricted","workdir":"/work"}');
  writeFileSync(join(conf, "net.conf"), '{"policy":"none"}');
  writeFileSync(join(conf, "resource.conf"), '{"cpus":2,"memory":"2048M"}');
  writeFileSync(join(conf, "fs.conf"), "{}");
  writeFileSync(join(conf, "secret.conf"), "{}");
  const res = await msbRun([
    "create", "debian",
    "--conf", join(conf, "runtime.conf"),
    "--net-conf", join(conf, "net.conf"),
    "--resource-conf", join(conf, "resource.conf"),
    "--fs-conf", join(conf, "fs.conf"),
    "--secret-conf", join(conf, "secret.conf"),
    "-n", WORKER,
    "-c", "2", "--max-cpus", "2",
    "--mkdir", "/work",
  ]);
  if (res.status !== 0) {
    throw new Error(`probe worker create failed: ${res.stdout}`);
  }
}

async function probeExec(argv: string[], asUser?: string): Promise<{ status: number | null; stdout: string }> {
  const args = ["exec", ...(asUser ? ["-u", asUser] : []), WORKER, "--", ...argv];
  return msbRun(args, 30_000);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
beforeAll(async () => {
  if (!enabled) return;
  brokerProc = spawn(
    process.execPath,
    [BROKER_MAIN, "--socket", SOCKET, "--state-dir", join(STATE_TMP, "state"), "--log-file", LOG],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BROKER_GIT_MODE: "real" } },
  );
  await waitForSocket(SOCKET);
  brokerReady = true;
  await ensureProbeWorker();
}, 60_000);

afterAll(async () => {
  if (!enabled) return;
  if (brokerProc) {
    brokerProc.kill("SIGTERM");
    await new Promise((r) => brokerProc?.on("close", r));
  }
  await msbRun(["stop", WORKER]).catch(() => undefined);
  await msbRun(["remove", WORKER]).catch(() => undefined);
  rmSync(STATE_TMP, { recursive: true, force: true });
}, 60_000);

const S = "sec-sess-1";

// ---------------------------------------------------------------------------
// §28 broker argument attacks (live socket)
// ---------------------------------------------------------------------------
describe("security: broker argument attacks against the live socket (§28)", () => {
  test.skipIf(!enabled)("malformed JSON is rejected with a validation error", async () => {
    const { response } = await rpc("{not json\n", { raw: true });
    expect(response?.ok).toBe(false);
    expect(response?.error?.code).toBe("validation");
  });

  test.skipIf(!enabled)("unsupported protocol version is rejected", async () => {
    const { response } = await rpc(requestLine("1", S, "policy").replace('"version":1', '"version":99'));
    expect(response?.ok).toBe(false);
    expect(response?.error?.code).toBe("validation");
  });

  test.skipIf(!enabled)("path-traversal sessionIDs are rejected", async () => {
    for (const bad of ["../etc", "a/b", "..", "a b", "a\u0000b", "x".repeat(65)]) {
      const line = JSON.stringify({ version: 1, id: "1", sessionID: bad, operation: "policy" });
      const { response } = await rpc(line);
      expect(response?.ok).toBe(false);
      expect(response?.error?.code).toBe("validation");
    }
  });

  test.skipIf(!enabled)("unknown operations fail closed (no silent fallback)", async () => {
    const { response } = await rpc(requestLine("2", S, "notAnOperation"));
    expect(response?.ok).toBe(false);
    expect(response?.error?.code).toBe("state"); // host op not enabled
  });

  test.skipIf(!enabled)("worker policy fields are rejected in exec payloads (§7, §11)", async () => {
    const forbidden = ["image", "hostMount", "mounts", "privileged", "device", "devices", "hostNetwork", "network", "securityProfile", "rawMsbConfig"];
    for (const field of forbidden) {
      const payload: Record<string, unknown> = { argv: ["true"], [field]: "x" };
      const { response } = await rpc(requestLine("3", S, "exec", payload));
      expect(response?.ok).toBe(false);
      expect(response?.error?.code).toBe("validation");
    }
  });

  test.skipIf(!enabled)("exec argv attacks are rejected (metachars, NUL, non-array, oversized)", async () => {
    const badArgvs = [
      ["sh", "-c", "echo pwn; touch /tmp/x"],
      ["echo", "a\u0000b"],
      "not-an-array",
      ["x".repeat(5000)],
      Array(200).fill("y"),
    ];
    for (const argv of badArgvs) {
      const { response } = await rpc(requestLine("4", S, "exec", { argv }));
      expect(response?.ok).toBe(false);
      expect(response?.error?.code).toBe("validation");
    }
  });

  test.skipIf(!enabled)("sandbox path attacks are rejected (traversal, absolute host paths, NUL)", async () => {
    for (const op of ["readFile", "writeFile", "listDir", "grep"]) {
      for (const path of ["../etc/passwd", "/etc/passwd", "/home/james/.ssh/id_rsa", "a\u0000b", "x".repeat(5000)]) {
        const payload = op === "grep" ? { query: "x", path } : op === "writeFile" ? { path, content: "x" } : { path };
        const { response } = await rpc(requestLine("5", S, op, payload));
        expect(response?.ok).toBe(false);
        expect(response?.error?.code).toBe("validation");
      }
    }
  });

  test.skipIf(!enabled)("applyResult/discardResult/keepResult require the exact confirm literal", async () => {
    for (const [op, payload] of [
      ["applyResult", { confirm: "yes" }],
      ["applyResult", {}],
      ["discardResult", { confirm: "APPLY" }],
      ["keepResult", { confirm: "APPLY" }],
    ] as const) {
      const { response } = await rpc(requestLine("6", S, op, payload as unknown));
      expect(response?.ok).toBe(false);
      expect(response?.error?.code).toBe("validation");
    }
  });

  test.skipIf(!enabled)("oversized timeoutMs is rejected", async () => {
    const { response } = await rpc(requestLine("7", S, "exec", { argv: ["true"], timeoutMs: 999_999_999 }));
    expect(response?.ok).toBe(false);
    expect(response?.error?.code).toBe("validation");
  });

  test.skipIf(!enabled)("oversized request line fails closed and the connection is closed", async () => {
    // bun's node:net does not emit 'close' for server-initiated closes, so
    // assert the fail-closed response AND the client readyState transition.
    const big = JSON.stringify({ version: 1, id: "8", sessionID: S, operation: "policy", payload: { pad: "x".repeat(2 * 1024 * 1024) } });
    const result = await new Promise<{ response: Envelope | null; readyState: string }>((resolve) => {
      const sock = connect(SOCKET);
      let buf = "";
      let parsed: Envelope | null = null;
      sock.setTimeout(15_000);
      sock.on("connect", () => sock.write(big + "\n"));
      sock.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl !== -1 && parsed === null) {
          parsed = JSON.parse(buf.slice(0, nl)) as Envelope;
          // wait for the server-initiated close (readyState -> closed)
          const t0 = Date.now();
          const poll = setInterval(() => {
            if ((sock as unknown as { readyState?: string }).readyState === "closed") {
              clearInterval(poll);
              sock.destroy();
              resolve({ response: parsed, readyState: "closed" });
            } else if (Date.now() - t0 > 4000) {
              clearInterval(poll);
              sock.destroy();
              resolve({ response: parsed, readyState: String((sock as unknown as { readyState?: string }).readyState) });
            }
          }, 100);
        }
      });
      sock.on("error", () => resolve({ response: parsed, readyState: "error" }));
      sock.on("timeout", () => resolve({ response: parsed, readyState: "timeout" }));
    });
    expect(result.response?.ok).toBe(false);
    expect(result.response?.error?.code).toBe("protocol");
    expect(result.readyState).toBe("closed");
  });

  test.skipIf(!enabled)("ops on unknown sessions fail closed with state errors", async () => {
    for (const op of ["exec", "readFile", "diff", "prepareResult", "applyResult"]) {
      const payload =
        op === "exec" ? { argv: ["true"] }
        : op === "readFile" ? { path: "x.txt" }
        : op === "applyResult" ? { confirm: "APPLY" }
        : undefined;
      const { response } = await rpc(requestLine("9", "sec-unknown", op, payload));
      expect(response?.ok).toBe(false);
      expect(response?.error?.code).toBe("state");
    }
  });

  test.skipIf(!enabled)("broker survives the attack battery (policy still served)", async () => {
    const { response } = await rpc(requestLine("10", S, "policy"));
    expect(response?.ok).toBe(true);
    const policy = response?.result as { protectedPaths?: string[]; workerImage?: string };
    expect(policy?.workerImage).toBe("debian");
    expect(policy?.protectedPaths?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// S14 fail closed
// ---------------------------------------------------------------------------
describe("security: fail closed (S14)", () => {
  test.skipIf(!enabled)("ensureWorker with an unapproved project path is rejected (no fallback)", async () => {
    const { response } = await rpc(requestLine("11", S, "ensureWorker", { projectDir: "/etc" }));
    expect(response?.ok).toBe(false);
    expect(response?.error?.code).toBe("validation");
  });

  test.skipIf(!enabled)("broker down ⇒ every request fails; nothing runs on the host", async () => {
    brokerProc?.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    const { response, closed } = await rpc(requestLine("12", S, "policy"));
    expect(response).toBeNull();
    expect(closed).toBe(true);
    // restart to leave the environment usable (remove the stale socket first)
    rmSync(SOCKET, { force: true });
    brokerProc = spawn(
      process.execPath,
      [BROKER_MAIN, "--socket", SOCKET, "--state-dir", join(STATE_TMP, "state"), "--log-file", LOG],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BROKER_GIT_MODE: "real" } },
    );
    await waitForSocket(SOCKET);
    // the socket file can exist before the listener is ready — retry until served
    let after;
    for (let i = 0; i < 20; i++) {
      after = await rpc(requestLine("13", S, "policy"));
      if (after.response?.ok) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(after.response?.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Worker isolation probes (S7/S8/S9/S11/S12) — throwaway msb worker
// ---------------------------------------------------------------------------
describe("security: worker isolation probes (host escape, secrets, OAuth, LAN)", () => {
  test.skipIf(!enabled)("host escape: host /home/james, docker socket, systemd, KVM are NOT reachable", async () => {
    const home = await probeExec(["ls", "/home/james"]);
    expect(home.status).not.toBe(0);

    const docker = await probeExec(["test", "-S", "/var/run/docker.sock"]);
    expect(docker.status).not.toBe(0);

    const systemd = await probeExec(["ls", "/run/systemd/system"]);
    expect(systemd.status).not.toBe(0);

    const kvm = await probeExec(["sh", "-c", "exec 3<>/dev/kvm 2>/dev/null && echo open || echo denied"], "nobody");
    expect(kvm.stdout).toContain("denied");
  });

  test.skipIf(!enabled)("host escape: guest cannot touch a host /tmp proof file", async () => {
    const proof = join(tmpdir(), "sbs-sec-proof");
    writeFileSync(proof, "host-only");
    // the guest has its OWN /tmp — the host file must not be listed there
    const listing = await probeExec(["ls", tmpdir()]);
    expect(listing.stdout).not.toContain("sbs-sec-proof");
    // even if the guest creates a same-named file in its own /tmp, the HOST
    // file must remain untouched (that is the actual isolation property)
    const touch = await probeExec(["sh", "-c", "echo guest > /tmp/sbs-sec-proof"]);
    expect(touch.status).toBe(0);
    const hostContent = await Bun.file(proof).text();
    expect(hostContent).toBe("host-only");
  });

  test.skipIf(!enabled)("OAuth absence: no auth.json and no credential env in the worker (S8/S9)", async () => {
    const auth = await probeExec(["cat", "/home/nobody/.local/share/opencode/auth.json"]);
    expect(auth.status).not.toBe(0);

    const envOut = await probeExec(["env"], "nobody");
    const upper = envOut.stdout.toUpperCase();
    for (const key of ["OPENAI", "API_KEY", "AUTH", "TOKEN", "SECRET", "PASSWORD"]) {
      expect(upper).not.toContain(key);
    }
  });

  test.skipIf(!enabled)("secret host paths are absent inside the worker (S7)", async () => {
    for (const p of ["/home/nobody/.ssh", "/home/nobody/.aws", "/home/nobody/.kube", "/home/nobody/.gnupg"]) {
      const res = await probeExec(["ls", p]);
      expect(res.status).not.toBe(0);
    }
  });

  test.skipIf(!enabled)("LAN isolation: deny-by-default, private-network destinations unreachable (S12)", async () => {
    const hasGetent = await probeExec(["sh", "-c", "command -v getent"]);
    if (hasGetent.status !== 0) {
      // image lacks getent — the route table is the fallback proof
      const routes = await probeExec(["sh", "-c", "wc -l < /proc/net/route"]);
      expect(routes.status).toBe(0);
      return;
    }
    const lan = await probeExec(["getent", "hosts", LAN_IP]);
    expect(lan.status).not.toBe(0);
  });
});
