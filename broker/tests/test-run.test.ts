import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { buildTestRunOp, testRunProvenance } from "../src/service.ts";
import { validateEnvelope } from "../src/validation.ts";
import type { BrokerRequestEnvelope } from "../src/types.ts";

const roots: string[] = [];
const envBefore = process.env.BROKER_TEST_RUNNERS;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (envBefore === undefined) delete process.env.BROKER_TEST_RUNNERS;
  else process.env.BROKER_TEST_RUNNERS = envBefore;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "broker-test-run-"));
  roots.push(root);
  return root;
}

function runner(root: string, argv: string[], overrides: Record<string, unknown> = {}) {
  return { id: "unit", language: "test", argv, cwd: ".", timeoutMs: 5000, maxOutputBytes: 4096, ...overrides };
}

function context(root: string, runners: unknown[] = [runner(root, ["/usr/bin/true"])]) {
  const stateDir = join(root, "..", `${basename(root)}-state`);
  roots.push(stateDir);
  const config = defaultConfig({
    projects: [{ id: "test-run", path: root }],
    testRunners: runners as never,
    stateDir,
  });
  return { config, store: { get: () => ({ agent: "gentle-orchestrator", state: "HOST_READ_ONLY", projectID: "test-run" }) }, git: {}, adapter: {}, budget: {}, resources: {}, pool: {}, hostRead: {}, logger: {} } as never;
}

function request(root: string, id = "unit"): BrokerRequestEnvelope {
  return { version: 1, id: "test-run", operation: "testRun", sessionID: "session-test", payload: { projectDir: root, runner: id } };
}

async function initializeRepo(root: string): Promise<void> {
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  expect(init.exitCode).toBe(0);
  Bun.spawnSync(["git", "config", "user.email", "test@example.invalid"], { cwd: root });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: root });
  writeFileSync(join(root, "tracked.txt"), "clean\n");
  Bun.spawnSync(["git", "add", "tracked.txt"], { cwd: root });
  Bun.spawnSync(["git", "commit", "-qm", "initial"], { cwd: root });
}

test("testRun is accepted by the canonical request envelope registry", () => {
  expect(validateEnvelope(request("/project"))).toMatchObject({ operation: "testRun" });
});

test("runner configuration rejects duplicate IDs", () => {
  process.env.BROKER_TEST_RUNNERS = JSON.stringify([runner(".", ["/usr/bin/true"]), runner(".", ["/usr/bin/true"])]);
  expect(() => defaultConfig()).toThrow(/BROKER_TEST_RUNNERS.*duplicate.*unit/i);
});

test("runner configuration rejects relative executable paths", () => {
  process.env.BROKER_TEST_RUNNERS = JSON.stringify([runner(".", ["usr/bin/true"])]);
  expect(() => defaultConfig()).toThrow(/BROKER_TEST_RUNNERS.*argv\[0\].*absolute/i);
});

test("runner configuration rejects parent traversal in cwd", () => {
  process.env.BROKER_TEST_RUNNERS = JSON.stringify([runner(".", ["/usr/bin/true"], { cwd: "src/../outside" })]);
  expect(() => defaultConfig()).toThrow(/BROKER_TEST_RUNNERS.*cwd/i);
});

test("runner configuration rejects out-of-range timeout", () => {
  process.env.BROKER_TEST_RUNNERS = JSON.stringify([runner(".", ["/usr/bin/true"], { timeoutMs: 999 })]);
  expect(() => defaultConfig()).toThrow(/BROKER_TEST_RUNNERS.*timeoutMs/i);
});

test("an empty runner configuration always refuses", async () => {
  const root = tempRoot();
  const op = buildTestRunOp(context(root, []));
  await expect(op(request(root))).rejects.toThrow(/TEST_RUNNERS_UNCONFIGURED/);
});

test("unknown runners are refused with the configured runner IDs", async () => {
  const root = tempRoot();
  const op = buildTestRunOp(context(root, [runner(root, ["/usr/bin/true"])]));
  await expect(op(request(root, "missing"))).rejects.toThrow(/unknown.*missing.*unit/i);
});

test("dirty trees run and return git provenance", async () => {
  const root = tempRoot();
  await initializeRepo(root);
  writeFileSync(join(root, "tracked.txt"), "dirty\n");
  expect(Bun.spawnSync(["git", "add", "tracked.txt"], { cwd: root }).exitCode).toBe(0);
  writeFileSync(join(root, "untracked.txt"), "new\n");
  const op = buildTestRunOp(context(root));
  const result = await op(request(root)) as { gitHead: string | null; dirtyPaths: string[]; dirtyPathsTruncated?: boolean; worktreeDigest: string | null };
  expect(result.gitHead).toMatch(/^[0-9a-f]{40}$/);
  expect(result.dirtyPaths).toContain("tracked.txt");
  expect(result.dirtyPaths).toContain("untracked.txt");
  expect(result.dirtyPathsTruncated).toBeUndefined();
  expect(result.worktreeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test("dirty path provenance is capped at 200 and marks truncation", async () => {
  const root = tempRoot();
  await initializeRepo(root);
  for (let index = 0; index < 205; index++) writeFileSync(join(root, `dirty-${index}.txt`), "new\n");
  const op = buildTestRunOp(context(root));
  const result = await op(request(root)) as { dirtyPaths: string[]; dirtyPathsTruncated?: boolean; provenanceTruncated?: boolean };
  expect(result.dirtyPaths).toHaveLength(200);
  expect(result.dirtyPathsTruncated).toBe(true);
  expect(result.provenanceTruncated).toBe(true);
});

test("provenance truncates when a slow git call consumes its remaining budget", () => {
  const root = tempRoot();
  let hashTimeout = 0;
  const result = testRunProvenance(root, {}, (args, timeoutMs) => {
    if (args[0] === "rev-parse") return { status: 0, stdout: `${"a".repeat(40)}\n` };
    if (args[0] === "status") return { status: 0, stdout: " M tracked.txt\0" };
    if (args[0] === "ls-files") return { status: 0, stdout: "" };
    hashTimeout = timeoutMs;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeoutMs + 20);
    return { status: null, stdout: "" };
  });
  expect(hashTimeout).toBeGreaterThan(0);
  expect(hashTimeout).toBeLessThanOrEqual(5000);
  expect(result.dirtyPaths).toContain("tracked.txt");
  expect(result.provenanceTruncated).toBe(true);
}, 7_000);

test("worktree digest is stable and changes when dirty content changes", async () => {
  const root = tempRoot();
  await initializeRepo(root);
  writeFileSync(join(root, "tracked.txt"), "first\n");
  const op = buildTestRunOp(context(root));
  const first = await op(request(root)) as { worktreeDigest: string | null };
  const second = await op(request(root)) as { worktreeDigest: string | null };
  expect(second.worktreeDigest).toBe(first.worktreeDigest);
  writeFileSync(join(root, "tracked.txt"), "second\n");
  const third = await op(request(root)) as { worktreeDigest: string | null };
  expect(third.worktreeDigest).not.toBe(first.worktreeDigest);
});

test("provenance snapshots the worktree before the runner mutates it", async () => {
  const root = tempRoot();
  await initializeRepo(root);
  const baseline = await buildTestRunOp(context(root, [runner(root, ["/usr/bin/true"])]))(request(root)) as { worktreeDigest: string | null };
  const mutation = `require('node:fs').writeFileSync(${JSON.stringify(join(root, "tracked.txt"))}, 'changed by test\\n')`;
  const op = buildTestRunOp(context(root, [runner(root, [process.execPath, "-e", mutation])]));

  const result = await op(request(root)) as { exitCode: number | null; dirtyPaths: string[]; worktreeDigest: string | null };

  expect(result.exitCode).toBe(0);
  expect(result.dirtyPaths).toEqual([]);
  expect(result.worktreeDigest).toBe(baseline.worktreeDigest);
});

test("git provenance failure does not change the runner result", async () => {
  const root = tempRoot();
  await initializeRepo(root);
  const fakeBin = join(root, "fake-bin");
  const fakeGit = join(fakeBin, "git");
  const originalPath = process.env.PATH;
  const op = buildTestRunOp(context(root, [runner(root, ["/usr/bin/true"])]));
  const priorPath = process.env.PATH ?? "";
  mkdirSync(fakeBin);
  writeFileSync(fakeGit, "#!/bin/sh\nexit 1\n");
  chmodSync(fakeGit, 0o755);
  process.env.PATH = `${fakeBin}:${priorPath}`;
  try {
    const result = await op(request(root)) as { exitCode: number | null; gitHead: string | null; dirtyPaths: string[] };
    expect(result).toMatchObject({ exitCode: 0, gitHead: null, dirtyPaths: [] });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("clean trees execute configured argv and return the process exit code", async () => {
  const root = tempRoot();
  await initializeRepo(root);
  const op = buildTestRunOp(context(root, [runner(root, ["/usr/bin/true"])]));
  const result = await op(request(root)) as { runner: string; exitCode: number; timedOut: boolean; logArtifact: string | null };
  expect(result).toMatchObject({ runner: "unit", exitCode: 0, timedOut: false });
  expect(result.logArtifact).not.toBeNull();
  expect(readFileSync(result.logArtifact!, "utf8")).toContain("runner=unit exitCode=0");
});

test("non-zero exit codes are returned without parsing test counts", async () => {
  const root = tempRoot();
  await initializeRepo(root);
  const op = buildTestRunOp(context(root, [runner(root, [process.execPath, "-e", "process.stdout.write('1281 pass, 0 fail\\n'); process.exit(7);"])]));
  await expect(op(request(root))).resolves.toMatchObject({ exitCode: 7, stdoutTail: expect.stringContaining("1281 pass") });
});

test("combined output caps set truncation and bound each returned tail", async () => {
  const root = tempRoot();
  await initializeRepo(root);
  const op = buildTestRunOp(context(root, [runner(root, [process.execPath, "-e", "process.stdout.write('x'.repeat(8192)); process.stderr.write('y'.repeat(8192));"], { maxOutputBytes: 1024 })]));
  const result = await op(request(root)) as { truncated: boolean; stdoutTail: string; stderrTail: string };
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.stdoutTail)).toBeLessThanOrEqual(8192);
  expect(Buffer.byteLength(result.stderrTail)).toBeLessThanOrEqual(8192);
});

test("timeout terminates the process group within timeout plus grace", async () => {
  const root = tempRoot();
  await initializeRepo(root);
  const op = buildTestRunOp(context(root, [runner(root, [process.execPath, "-e", "setTimeout(() => {}, 10000);"], { timeoutMs: 1000 })]));
  const started = Date.now();
  await expect(op(request(root))).resolves.toMatchObject({ timedOut: true });
  expect(Date.now() - started).toBeLessThan(4000);
});
