import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { buildGitWorktreeOp, authorizeHostDispatch } from "../src/service.ts";
import { gitDirFor, findProject, resolveProjectID } from "../src/validation.ts";
import type { BrokerRequestEnvelope } from "../src/types.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

async function git(argv: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (status !== 0) throw new Error(`git ${argv.join(" ")} failed (${status}): ${stderr}`);
  return stdout.trim();
}

async function fixture() {
  const base = tempDir("git-worktree-op-");
  const repoDir = join(base, "repo");
  const rootDir = join(base, "worktrees");
  const projectDir = join(rootDir, "sample");
  mkdirSync(repoDir);
  mkdirSync(projectDir, { recursive: true });
  await git(["init", "-b", "main"], repoDir);
  await git(["config", "user.name", "Test"], repoDir);
  await git(["config", "user.email", "test@example.invalid"], repoDir);
  writeFileSync(join(repoDir, "tracked.txt"), "worktree fixture\n");
  await git(["add", "tracked.txt"], repoDir);
  await git(["commit", "-m", "initial"], repoDir);
  const sha = await git(["rev-parse", "HEAD"], repoDir);
  const config = defaultConfig({
    readOnlyAgents: ["gentle-orchestrator"],
    projects: [{ id: "repo", path: repoDir }, { id: "wtroot", path: rootDir }],
  });
  const store = { get: (sessionID: string) => ({
    sessionID, state: "HOST_READ_ONLY", agent: "gentle-orchestrator", createdAt: "now", updatedAt: "now",
  }) };
  const spawn = async (argv: string[], options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }) => {
    const proc = Bun.spawn(argv, { cwd: options?.cwd, env: { ...process.env, ...options?.env }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { status, stdout, stderr, timedOut: false };
  };
  const ctx = { config, store, git: { runnerMode: "direct", spawn } } as never;
  return { repoDir, rootDir, projectDir, sha, ctx };
}

function request(payload: Record<string, unknown>, agent = "gentle-orchestrator"): BrokerRequestEnvelope {
  return { version: 1, id: "worktree-test", operation: "gitWorktree", sessionID: "worktree-session", agent, payload };
}

describe("host git worktree creation", () => {
  test.each([undefined, "HEAD"])("creates a routable worktree from %s", async (base) => {
    const f = await fixture();
    const name = base === undefined ? "default" : "explicit";
    const target = join(f.rootDir, "sample", name);
    const result = await buildGitWorktreeOp(f.ctx)(request({
      repoDir: f.repoDir, rootDir: f.rootDir, project: "sample", name,
      branch: "feat/x", ...(base === undefined ? {} : { base }),
    })) as Record<string, string>;
    expect(existsSync(target)).toBe(true);
    expect(await Bun.file(join(target, "tracked.txt")).text()).toBe("worktree fixture\n");
    expect(await git(["-C", target, "rev-parse", "--verify", "HEAD"])).toBe(f.sha);
    expect(await git(["-C", target, "symbolic-ref", "--short", "-q", "HEAD"])).toBe("feat/x");
    expect(result).toMatchObject({ sha: f.sha, target, projectID: `wtroot~sample~${name}`, branch: "feat/x" });
    expect(resolveProjectID(target, f.ctx.config.projects)).toBe(`wtroot~sample~${name}`);
    expect(findProject(f.ctx.config.projects, `wtroot~sample~${name}`)?.path).toBe(target);
    expect(gitDirFor(target)).toBe(join(f.repoDir, ".git", "worktrees", name));
  });

  test("creates from an explicit named base", async () => {
    const f = await fixture();
    const target = join(f.rootDir, "sample", "named");
    const result = await buildGitWorktreeOp(f.ctx)(request({ repoDir: f.repoDir, rootDir: f.rootDir,
      project: "sample", name: "named", branch: "feat/x", base: "main" })) as Record<string, string>;
    expect(result.base).toBe("main");
    expect(await git(["-C", target, "rev-parse", "HEAD"])).toBe(f.sha);
  });

  test("refuses every invalid precondition without creating or changing the target", async () => {
    const cases = ["existing target", "missing project", "project is a file", "existing branch", "unknown base", "flag base", "non-checkout repo", "checkout root"] as const;
    for (const kind of cases) {
      const f = await fixture();
      const name = `case-${kind.replaceAll(" ", "-")}`;
      const target = join(f.rootDir, "sample", name);
      let payload: Record<string, unknown> = {
        repoDir: f.repoDir, rootDir: f.rootDir, project: "sample", name, branch: "feat/x",
      };
      if (kind === "existing target") {
        mkdirSync(target);
        writeFileSync(join(target, "sentinel"), "unchanged");
      } else if (kind === "missing project") {
        rmSync(f.projectDir, { recursive: true, force: true });
      } else if (kind === "project is a file") {
        rmSync(f.projectDir, { recursive: true, force: true });
        writeFileSync(f.projectDir, "unchanged");
      } else if (kind === "existing branch") {
        await git(["branch", "feat/x", f.sha], f.repoDir);
      } else if (kind === "unknown base") {
        payload.base = "no-such-ref";
      } else if (kind === "flag base") {
        payload.base = "-x";
      } else if (kind === "non-checkout repo") {
        rmSync(join(f.repoDir, ".git"), { recursive: true, force: true });
      } else if (kind === "checkout root") {
        mkdirSync(join(f.repoDir, "sample"));
        payload.rootDir = f.repoDir;
      }
      await expect(buildGitWorktreeOp(f.ctx)(request(payload))).rejects.toThrow();
      if (kind === "existing target") {
        expect(await Bun.file(join(target, "sentinel")).text()).toBe("unchanged");
      } else {
        expect(existsSync(target)).toBe(false);
      }
    }
  });

  test("refuses a symlinked project directory without adding anything outside the root", async () => {
    const f = await fixture();
    const outside = tempDir("git-worktree-outside-");
    const before = readdirSync(outside).sort();
    rmSync(f.projectDir, { recursive: true, force: true });
    symlinkSync(outside, f.projectDir, "dir");
    await expect(buildGitWorktreeOp(f.ctx)(request({ repoDir: f.repoDir, rootDir: f.rootDir,
      project: "sample", name: "escape", branch: "feat/x" }))).rejects.toThrow();
    expect(readdirSync(outside).sort()).toEqual(before);
  });

  test("rejects an outside-resolving target before invoking git worktree add", async () => {
    const f = await fixture();
    const outside = tempDir("git-worktree-target-outside-");
    rmSync(f.projectDir, { recursive: true, force: true });
    symlinkSync(outside, f.projectDir, "dir");
    const target = join(outside, "escape");
    let addCalls = 0;
    const gitCtx = f.ctx as { git: { spawn: (...args: any[]) => Promise<any> } };
    const spawn = gitCtx.git.spawn;
    gitCtx.git.spawn = async (argv: string[], ...rest: any[]) => {
      if (argv[1] === "worktree" && argv[2] === "add") addCalls++;
      return spawn(argv, ...rest);
    };
    await expect(buildGitWorktreeOp(f.ctx)(request({ repoDir: f.repoDir, rootDir: f.rootDir,
      project: "sample", name: "escape", branch: "feat/x" }))).rejects.toThrow();
    expect(addCalls).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  test("authorization runs before payload validation for a non-orchestrator", async () => {
    const f = await fixture();
    (f.ctx as { store: { get: (sessionID: string) => unknown } }).store.get = (sessionID: string) => ({
      sessionID, state: "HOST_READ_ONLY", agent: "general", createdAt: "now", updatedAt: "now",
    });
    await expect(buildGitWorktreeOp(f.ctx)(request({ invalid: true }, "general"))).rejects.toThrow();
    expect(() => authorizeHostDispatch(f.ctx, "gitWorktree", "worktree-session", "general")).toThrow();
  });

  test("rejects undeclared payload keys", async () => {
    const f = await fixture();
    const target = join(f.rootDir, "sample", "unknown-key");
    await expect(buildGitWorktreeOp(f.ctx)(request({ repoDir: f.repoDir, rootDir: f.rootDir,
      project: "sample", name: "unknown-key", branch: "feat/x", surprise: true }))).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });
});
