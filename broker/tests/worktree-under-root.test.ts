import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirFor, resolveCanonicalProjectRoot } from "../src/service.ts";
import { SddRuntimeExecutor } from "../src/sdd-runtime.ts";
import { baseProjectID, findProject, resolveProjectID, resolveWorktreeAwareRoot } from "../src/validation.ts";

let base: string;
let root: string; // a registered worktree root: not itself a git checkout
let repoRoot: string; // an ordinary registered project: a git checkout
const ctxFor = (path: string) => ({ config: { projects: [{ id: "p", path }] } }) as never;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "wt-under-root-")));
  root = join(base, "worktrees");
  mkdirSync(join(root, "proj", "feat-a"), { recursive: true });
  writeFileSync(join(root, "proj", "feat-a", ".git"), "gitdir: /elsewhere\n");
  mkdirSync(join(root, "proj", "plain-dir"), { recursive: true }); // no .git
  mkdirSync(join(root, "proj", "feat-a", "sub"), { recursive: true });
  mkdirSync(join(root, "toplevel"), { recursive: true });
  writeFileSync(join(root, "toplevel", ".git"), "gitdir: /elsewhere\n"); // depth 1, not <project>/<name>
  repoRoot = join(base, "repo");
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  mkdirSync(join(repoRoot, "pkg", "inner"), { recursive: true });
  writeFileSync(join(repoRoot, "pkg", "inner", ".git"), "gitdir: /elsewhere\n");
  mkdirSync(join(base, "outside", "x"), { recursive: true });
  writeFileSync(join(base, "outside", "x", ".git"), "gitdir: /elsewhere\n");
  symlinkSync(join(base, "outside"), join(root, "escape"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("worktrees under a registered worktree root (D36)", () => {
  test("the root itself still resolves to the root", () => {
    expect(resolveCanonicalProjectRoot(ctxFor(root), root).projectRoot).toBe(root);
  });
  test("a git worktree at <root>/<project>/<name> resolves to that worktree", () => {
    const wt = join(root, "proj", "feat-a");
    expect(resolveCanonicalProjectRoot(ctxFor(root), wt)).toEqual({ projectID: "p~proj~feat-a", projectRoot: wt });
  });
  test("refuses a directory without .git, a subdirectory of a worktree, and the wrong depth", () => {
    for (const dir of [join(root, "proj", "plain-dir"), join(root, "proj", "feat-a", "sub"), join(root, "proj"), join(root, "toplevel")]) {
      expect(() => resolveCanonicalProjectRoot(ctxFor(root), dir)).toThrow("exact approved project root");
    }
  });
  test("refuses a symlink that leaves the root", () => {
    expect(() => resolveCanonicalProjectRoot(ctxFor(root), join(root, "escape", "x"))).toThrow();
  });
  test("an ordinary project (a git checkout) keeps exact-root equality, even for a nested .git", () => {
    expect(resolveCanonicalProjectRoot(ctxFor(repoRoot), repoRoot).projectRoot).toBe(repoRoot);
    expect(() => resolveCanonicalProjectRoot(ctxFor(repoRoot), join(repoRoot, "pkg", "inner"))).toThrow("exact approved project root");
    expect(() => resolveCanonicalProjectRoot(ctxFor(repoRoot), join(repoRoot, "pkg"))).toThrow("exact approved project root");
  });
  test("the helper is the single rule (positive and negative control)", () => {
    expect(resolveWorktreeAwareRoot(root, join(root, "proj", "feat-a"))).toBe(join(root, "proj", "feat-a"));
    expect(resolveWorktreeAwareRoot(root, join(root, "proj", "plain-dir"))).toBeUndefined();
  });
  test("the SDD runtime applies the same rule", () => {
    const ex = new SddRuntimeExecutor({ binary: "/bin/true", projects: [{ id: "p", path: root }] } as never);
    expect(ex.resolveProjectRoot(join(root, "proj", "feat-a"))).toBe(join(root, "proj", "feat-a"));
    expect(() => ex.resolveProjectRoot(join(root, "proj", "plain-dir"))).toThrow("exact approved project root");
  });
  test("a worker's project directory is the worktree, not the registered root (the git-repository failure)", () => {
    const wt = join(root, "proj", "feat-a");
    const id = resolveProjectID(wt, [{ id: "p", path: root }]);
    expect(id).toBe("p~proj~feat-a");
    expect(projectDirFor(ctxFor(root), id)).toBe(wt);
    expect(resolveProjectID(root, [{ id: "p", path: root }])).toBe("p");
  });
  test("findProject rejects tampered virtual ids and a worktree that lost its .git", () => {
    const projects = [{ id: "p", path: root }];
    for (const id of ["p~..~x", "p~proj", "p~proj~feat-a~extra", "p~proj~plain-dir", "p~toplevel", "nope~proj~feat-a", "p~proj~..", "p~~feat-a"]) {
      expect(findProject(projects, id)).toBeUndefined();
    }
    expect(findProject(projects, "p~proj~feat-a")?.path).toBe(join(root, "proj", "feat-a"));
    expect(findProject(projects, "p")?.path).toBe(root);
    expect(findProject([{ id: "r", path: repoRoot }], "r~pkg~inner")).toBeUndefined();
  });
  test("advisor records stay keyed by the root id", () => {
    expect(baseProjectID("p~proj~feat-a")).toBe("p");
    expect(baseProjectID("p")).toBe("p");
  });
});
