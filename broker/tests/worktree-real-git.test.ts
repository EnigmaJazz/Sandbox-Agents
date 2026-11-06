import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRepositoryLocalConfigSafe } from "../src/gitguard.ts";
import { gitDirFor, resolveProjectID, findProject } from "../src/validation.ts";

// A REAL linked worktree (git init + git worktree add), not a fake `.git` file: its `.git` is a file.
let base: string;
let root: string;
let main: string;
let wt: string;
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "wt-real-")));
  main = join(base, "main");
  root = join(base, "root");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "f.txt"), "x\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  mkdirSync(join(root, "proj"), { recursive: true });
  wt = join(root, "proj", "feat");
  git(main, "worktree", "add", "-q", "-b", "feat", wt);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("a real linked worktree under a worktree root", () => {
  test("fixture control: .git is a file, so the old `join(dir, '.git')` is not a git directory", () => {
    expect(statSync(join(wt, ".git")).isFile()).toBe(true);
    expect(statSync(gitDirFor(wt)).isDirectory()).toBe(true);
    expect(statSync(gitDirFor(main)).isDirectory()).toBe(true);
    expect(gitDirFor(main)).toBe(join(main, ".git"));
  });
  test("it resolves to a virtual project whose path is the worktree", () => {
    const id = resolveProjectID(wt, [{ id: "p", path: root }]);
    expect(id).toBe("p~proj~feat");
    expect(findProject([{ id: "p", path: root }], id)?.path).toBe(wt);
  });
  test("git run with GIT_DIR = gitDirFor(worktree) sees the worktree's own branch and HEAD", () => {
    const env = { ...process.env, GIT_DIR: gitDirFor(wt) };
    const r = Bun.spawnSync(["git", "symbolic-ref", "--short", "HEAD"], { cwd: wt, env });
    expect(r.stdout.toString().trim()).toBe("feat");
  });
  test("the config guard resolves the worktree's git directory (it fails closed on the .git file)", () => {
    expect(() => assertRepositoryLocalConfigSafe(wt, { GIT_DIR: join(wt, ".git") })).toThrow("could not be resolved");
    expect(() => assertRepositoryLocalConfigSafe(wt, { GIT_DIR: gitDirFor(wt) })).not.toThrow();
  });
  test("positive control: an execution-bearing key in the shared config is still caught from the worktree", () => {
    git(main, "config", "core.sshCommand", "/bin/evil");
    expect(() => assertRepositoryLocalConfigSafe(wt, { GIT_DIR: gitDirFor(wt) })).toThrow();
    git(main, "config", "--unset", "core.sshCommand");
    expect(() => assertRepositoryLocalConfigSafe(wt, { GIT_DIR: gitDirFor(wt) })).not.toThrow();
  });
});
