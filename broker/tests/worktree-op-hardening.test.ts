import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGitWorktreeOp } from "../src/service.ts";
import { spawnArgv } from "../src/msb.ts";
import { defaultConfig } from "../src/config.ts";
import { gitDirFor } from "../src/validation.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tempDir(): string { const path = mkdtempSync(join(tmpdir(), "git-worktree-hardening-")); roots.push(path); return path; }
async function git(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (status !== 0) throw new Error(`git ${args.join(" ")} failed (${status}): ${stderr}`);
  return stdout.trim();
}
async function fixture(spawnOverride?: (argv: readonly string[], opts?: any) => Promise<any>) {
  const base = tempDir(); const repoDir = join(base, "repo"); const rootDir = join(base, "worktrees"); const projectDir = join(rootDir, "sample");
  mkdirSync(repoDir); mkdirSync(projectDir, { recursive: true });
  await git(["init", "-b", "main"], repoDir); await git(["config", "user.name", "Test"], repoDir); await git(["config", "user.email", "test@example.invalid"], repoDir);
  writeFileSync(join(repoDir, "tracked.txt"), "worktree fixture\n"); await git(["add", "tracked.txt"], repoDir); await git(["commit", "-m", "initial"], repoDir);
  const sha = await git(["rev-parse", "HEAD"], repoDir);
  const config = defaultConfig({ readOnlyAgents: ["gentle-orchestrator"], projects: [{ id: "repo", path: repoDir }, { id: "wtroot", path: rootDir }] });
  const store = { get: (sessionID: string) => ({ sessionID, state: "HOST_READ_ONLY", agent: "gentle-orchestrator", createdAt: "now", updatedAt: "now" }) };
  const spawn = spawnOverride ?? ((argv: readonly string[], opts?: any) => spawnArgv(argv, opts));
  const ctx = { config, store, git: { runnerMode: "direct", spawn } } as never;
  return { repoDir, rootDir, projectDir, sha, ctx };
}
const payload = (f: Awaited<ReturnType<typeof fixture>>, branch = "topic") => ({ repoDir: f.repoDir, rootDir: f.rootDir, project: "sample", name: branch, branch });
const request = (f: Awaited<ReturnType<typeof fixture>>, branch = "topic") => ({ version: 1, id: "test", operation: "gitWorktree", sessionID: "worktree-session", agent: "gentle-orchestrator", payload: payload(f, branch) } as any);
const invoke = (f: Awaited<ReturnType<typeof fixture>>, branch = "topic") => buildGitWorktreeOp(f.ctx)(request(f, branch));

describe("git worktree hardening", () => {
  test("refuses local execution filters before creating a worktree", async () => {
    const unsafe = await fixture();
    writeFileSync(join(unsafe.repoDir, ".gitattributes"), "*.txt filter=probe\n");
    await git(["add", ".gitattributes"], unsafe.repoDir); await git(["commit", "-m", "add filter attribute"], unsafe.repoDir);
    const script = join(tempDir(), "smudge-filter"); const marker = join(tempDir(), "filter-ran");
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`); chmodSync(script, 0o755);
    await git(["config", "filter.probe.smudge", script], unsafe.repoDir);
    await expect(invoke(unsafe)).rejects.toThrow(/filter.*smudge/i);
    expect(existsSync(join(unsafe.projectDir, "topic"))).toBe(false); expect(existsSync(marker)).toBe(false);
    const safe = await fixture();
    writeFileSync(join(safe.repoDir, ".gitattributes"), "*.txt filter=probe\n");
    await git(["add", ".gitattributes"], safe.repoDir); await git(["commit", "-m", "add inert filter attribute"], safe.repoDir);
    await expect(invoke(safe)).resolves.toBeDefined(); expect(readFileSync(join(safe.projectDir, "topic", "tracked.txt"), "utf8")).toBe("worktree fixture\n");
  });
  test("refuses an in-root project alias without creating a branch or worktree", async () => {
    const f = await fixture();
    const actual = join(f.rootDir, "actual");
    mkdirSync(actual);
    rmSync(f.projectDir, { recursive: true, force: true });
    symlinkSync(actual, f.projectDir, "dir");
    await expect(invoke(f)).rejects.toThrow(/alias/i);
    expect(await git(["branch", "--list", "topic"], f.repoDir)).toBe("");
    const worktrees = await git(["worktree", "list", "--porcelain"], f.repoDir);
    expect(worktrees).not.toContain(join(f.rootDir, "actual", "topic"));
    expect(existsSync(join(f.rootDir, "actual", "topic"))).toBe(false);
  });
  test("postconditions succeed with production spawn and retain git worktree data", async () => {
    const f = await fixture(); const result = await invoke(f);
    expect(readFileSync(join(f.projectDir, "topic", "tracked.txt"), "utf8")).toBe("worktree fixture\n");
    expect(await git(["rev-parse", "HEAD"], join(f.projectDir, "topic"))).toBe(f.sha); expect(result.branch).toBe("topic");
    const old = await fixture(async (argv, opts) => {
      const proc = Bun.spawn([...argv], { cwd: opts?.cwd, env: { ...process.env, ...opts?.env }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); return { status, stdout, stderr, timedOut: false };
    });
    await expect(invoke(old)).resolves.toBeDefined();
  });
  test("rejects checkout destinations and symlink aliases before add", async () => {
    const f = await fixture(); await git(["init", "-b", "main"], f.projectDir); let adds = 0;
    const counted = await fixture((argv, opts) => { if (argv.includes("worktree") && argv.includes("add")) adds++; return spawnArgv(argv, opts); });
    // Use the first fixture's checkout as the project under test.
    const config = (counted.ctx as any).config; config.projects[1].path = f.rootDir;
    await expect(buildGitWorktreeOp(counted.ctx)(request({ ...counted, repoDir: counted.repoDir, rootDir: f.rootDir, projectDir: f.projectDir } as any))).rejects.toThrow();
    expect(adds).toBe(0); expect(() => readFileSync(join(f.projectDir, "topic"))).toThrow();
    const aliasDir = join(f.rootDir, "alias-checkout"); mkdirSync(aliasDir, { recursive: true }); await git(["init", "-b", "main"], aliasDir);
    rmSync(f.projectDir, { recursive: true, force: true }); symlinkSync(aliasDir, f.projectDir);
    await expect(invoke({ ...counted, rootDir: f.rootDir, projectDir: f.projectDir } as any)).rejects.toThrow(); expect(adds).toBe(0);
    rmSync(join(aliasDir, ".git"), { recursive: true, force: true });
    const clean = await fixture(); await expect(invoke(clean)).resolves.toBeDefined();
  });
  test("binds repo and verified destination git directories on every spawn", async () => {
    const f = await fixture(); const calls: { argv: readonly string[]; cwd?: string; gitDir?: string }[] = [];
    const observed = await fixture((argv, opts) => { calls.push({ argv, cwd: opts?.cwd, gitDir: opts?.env?.GIT_DIR }); return spawnArgv(argv, opts); });
    const result = await invoke(observed); const target = join(observed.projectDir, "topic");
    expect(result).toBeDefined();
    const repoCalls = calls.filter(call => call.cwd === observed.repoDir);
    const destinationCalls = calls.filter(call => call.cwd === target);
    expect(repoCalls.some(call => call.argv.includes("show-ref"))).toBe(true);
    expect(repoCalls.some(call => call.argv.includes("worktree") && call.argv.includes("add"))).toBe(true);
    expect(repoCalls.some(call => call.argv.includes("rev-parse") && call.argv.some(a => a.endsWith("^{commit}")))).toBe(true);
    expect(repoCalls.every(call => call.gitDir === gitDirFor(observed.repoDir))).toBe(true);
    expect(destinationCalls.some(call => call.argv.includes("symbolic-ref"))).toBe(true);
    expect(destinationCalls.every(call => call.gitDir === gitDirFor(target))).toBe(true);
    expect(calls.every(call => !call.argv.includes("-C"))).toBe(true);
  });
});
