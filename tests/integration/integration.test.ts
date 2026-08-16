/**
 * Gated integration suite (SYSTEM_PROMPT.md §28; spec §27 Gate 5).
 *
 * Skipped unless SANDBOX_GATED_TESTS=integration (or "all"):
 *
 *   SANDBOX_GATED_TESTS=integration bun test tests/integration/
 *
 * Gate 5: throwaway-project lazy sandbox test. Spawns its OWN test broker
 * (isolated socket/state, BROKER_GIT_MODE=real, one throwaway git project
 * from BROKER_PROJECTS, prepared worker root disk) so the SYSTEMD broker is
 * untouched. Exercises the full ensureWorker path: snapshot (temp index,
 * synthetic baseline under refs/opencode-sandbox/baseline/<session>),
 * msb worker from the prepared root disk, bundle transfer, worker repo
 * init/fetch/checkout.
 *
 * Requires (Gate 3-verified): msb 0.6.9, the `debian` image, and the
 * prepared worker disk at ~/.local/share/opencode-sandbox/worker-image/
 * (built by scripts/build-worker-image).
 *
 * Gate 5: NOT self-certified — the USER reviews results.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

const GATE = process.env.SANDBOX_GATED_TESTS ?? "";
const enabled = GATE === "integration" || GATE === "all";

const BROKER_MAIN = join(import.meta.dir, "..", "..", "broker", "src", "main.ts");
const STATE_TMP = mkdtempSync(join(tmpdir(), "sbs-int-"));
const SOCKET = join(STATE_TMP, "broker.sock");
const PROJECT = join(STATE_TMP, "project");
const EXTERNAL_ROOT = join(STATE_TMP, "external-root");
const WORKER_DISK = join(
  process.env.HOME ?? "/home/james",
  ".local/share/opencode-sandbox/worker-image/worker.ext4",
);

let brokerProc: ReturnType<typeof spawn> | null = null;
let requestSeq = 0;

interface Envelope {
  version: number;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

function rpc(operation: string, sessionID: string, payload?: unknown): Promise<Envelope> {
  const id = String(++requestSeq);
  const line = JSON.stringify({
    version: 1,
    id,
    sessionID,
    operation,
    ...(payload === undefined ? {} : { payload }),
  });
  return new Promise((resolve) => {
    const sock = connect(SOCKET);
    let buf = "";
    sock.setTimeout(20_000);
    sock.on("connect", () => sock.write(line + "\n"));
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        sock.destroy();
        resolve(JSON.parse(buf.slice(0, nl)) as Envelope);
      }
    });
    sock.on("error", () => resolve({ version: 1, id, ok: false, error: { code: "internal", message: "socket error" } }));
    sock.on("timeout", () => resolve({ version: 1, id, ok: false, error: { code: "internal", message: "timeout" } }));
  });
}

async function waitForSocket(path: string, timeoutMs = 20_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`broker socket never appeared at ${path}`);
}

function msbRun(args: string[], timeoutMs = 120_000): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn("/home/james/.local/bin/msb", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout: out });
    });
  });
}

async function msbWorkerNames(): Promise<string[]> {
  const res = await msbRun(["list"]);
  return res.stdout
    .split("\n")
    .map((l) => l.split(/\s+/)[0] ?? "")
    .filter((n) => n.startsWith("oc-sandbox-"));
}

function git(repoDir: string, args: string[]): void {
  const res = Bun.spawnSync(["git", ...args], { cwd: repoDir });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
}

beforeAll(async () => {
  if (!enabled) return;
  if (!existsSync(WORKER_DISK)) {
    throw new Error(`prepared worker disk missing: ${WORKER_DISK} (run scripts/build-worker-image first)`);
  }
  // Clean leftover workers from aborted runs (idempotent re-runs).
  for (const name of await msbWorkerNames()) {
    await msbRun(["stop", name]);
    await msbRun(["remove", name]);
  }
  // Throwaway project: real git repo with one commit and a tracked file.
  mkdirSync(PROJECT, { recursive: true });
  writeFileSync(join(PROJECT, "file.txt"), "v1\n");
  git(PROJECT, ["init", "-q", "-b", "main"]);
  git(PROJECT, ["add", "-A"]);
  git(PROJECT, ["commit", "-q", "-m", "initial"]);
  // Approved external read root (S6).
  mkdirSync(EXTERNAL_ROOT, { recursive: true });
  writeFileSync(join(EXTERNAL_ROOT, "ref.txt"), "external\n");

  brokerProc = spawn(
    process.execPath,
    [BROKER_MAIN, "--socket", SOCKET, "--state-dir", join(STATE_TMP, "state"), "--log-file", join(STATE_TMP, "broker.log")],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        BROKER_GIT_MODE: "real",
        BROKER_WORKER_ROOT_DISK: WORKER_DISK,
        BROKER_PROJECTS: JSON.stringify([{ id: "g5", path: PROJECT }]),
        BROKER_EXTERNAL_ROOTS: JSON.stringify([EXTERNAL_ROOT]),
      },
    },
  );
  await waitForSocket(SOCKET);
}, 120_000);

afterAll(async () => {
  if (!enabled) return;
  if (brokerProc) {
    brokerProc.kill("SIGTERM");
    await new Promise((r) => brokerProc?.on("close", r));
  }
  for (const name of await msbWorkerNames()) {
    await msbRun(["stop", name]);
    await msbRun(["remove", name]);
  }
  rmSync(STATE_TMP, { recursive: true, force: true });
}, 120_000);

const A = "g5-session-a";
const B = "g5-session-b";

describe("integration: lazy creation, reuse, separation, read switch (§28, Gate 5)", () => {
  test.skipIf(!enabled)("read-only investigation creates ZERO workers", async () => {
    expect(await msbWorkerNames()).toEqual([]);
    const metrics = await rpc("metrics", A);
    expect(metrics.ok).toBe(true);
    expect((metrics.result as { workersActive?: number }).workersActive).toBe(0);
    const list = await rpc("listWorkers", A);
    expect(list.ok).toBe(true);
    expect((list.result as { workers: unknown[] }).workers).toEqual([]);
    // policy is readable before any activation
    const policy = await rpc("policy", A);
    expect(policy.ok).toBe(true);
    expect(await msbWorkerNames()).toEqual([]);
  });

  test.skipIf(!enabled)("first sandbox-required operation creates EXACTLY ONE worker", async () => {
    const res = await rpc("ensureWorker", A, { projectDir: PROJECT });
    expect(res.ok).toBe(true);
    const created = res.result as { worker?: string; reused?: boolean };
    expect(created.reused).toBe(false);
    expect(created.worker).toBe(`oc-sandbox-${A}`);
    const workers = await msbWorkerNames();
    expect(workers).toEqual([`oc-sandbox-${A}`]);
    // baseline ref exists in the host repo under the sandbox namespace
    const ref = Bun.spawnSync(["git", "rev-parse", "--verify", `refs/opencode-sandbox/baseline/${A}`], {
      cwd: PROJECT,
    });
    expect(ref.exitCode).toBe(0);
  }, 120_000);

  test.skipIf(!enabled)("subsequent ops in the same session reuse the same worker", async () => {
    const res = await rpc("ensureWorker", A, { projectDir: PROJECT });
    expect(res.ok).toBe(true);
    const result = res.result as { reused?: boolean; worker?: string };
    expect(result.reused).toBe(true);
    expect(result.worker).toBe(`oc-sandbox-${A}`);
    expect(await msbWorkerNames()).toEqual([`oc-sandbox-${A}`]);
  });

  test.skipIf(!enabled)("a different session ID gets a different worker (S13)", async () => {
    const res = await rpc("ensureWorker", B, { projectDir: PROJECT });
    expect(res.ok).toBe(true);
    const result = res.result as { worker?: string };
    expect(result.worker).toBe(`oc-sandbox-${B}`);
    const workers = await msbWorkerNames();
    expect(workers).toContain(`oc-sandbox-${A}`);
    expect(workers).toContain(`oc-sandbox-${B}`);
    expect(workers.length).toBe(2);
  }, 120_000);

  test.skipIf(!enabled)("read switch: sandbox reads see the modified copy, host stays unchanged (S5/S2)", async () => {
    // worker write (path relative to the sandbox project root)
    const write = await rpc("writeFile", A, { path: "file.txt", content: "v2\n" });
    expect(write.ok).toBe(true);
    // sandbox read returns the new content
    const read = await rpc("readFile", A, { path: "file.txt" });
    expect(read.ok).toBe(true);
    expect((read.result as { content?: string }).content).toBe("v2\n");
    // the host working tree is untouched
    expect(readFileSync(join(PROJECT, "file.txt"), "utf8")).toBe("v1\n");
  });

  test.skipIf(!enabled)("external read data remains available while a sandbox is active (S6)", async () => {
    const policy = await rpc("policy", A);
    expect(policy.ok).toBe(true);
    const roots = (policy.result as { approvedExternalReadRoots?: string[] }).approvedExternalReadRoots ?? [];
    expect(roots).toContain(EXTERNAL_ROOT);
    // host read-only ops still work during SANDBOX_ACTIVE
    const mem = await rpc("hostMemory", A);
    expect(mem.ok).toBe(true);
    expect((mem.result as { stdout?: string }).stdout ?? "").toMatch(/Mem/i);
  });

  test.skipIf(!enabled)("external writes fail or require explicit approval (§28 external write)", async () => {
    // absolute host paths are rejected by sandbox-path validation
    const abs = await rpc("writeFile", A, { path: `${EXTERNAL_ROOT}/evil.txt`, content: "x" });
    expect(abs.ok).toBe(false);
    expect(abs.error?.code).toBe("validation");
    // traversal is rejected
    const trav = await rpc("writeFile", A, { path: "../../etc/evil", content: "x" });
    expect(trav.ok).toBe(false);
    expect(trav.error?.code).toBe("validation");
    // nothing was written anywhere
    expect(existsSync(join(EXTERNAL_ROOT, "evil.txt"))).toBe(false);
  });
});
