/**
 * D36 — worktree-root mode of `scripts/register-project.ts`.
 *
 * `--worktree-root <root>/<project>` creates `<root>/<project>/` and registers the ROOT once, so every worktree
 * under it is covered without a per-worktree registration or a stack restart. A root is not a git project: the
 * mode never runs `git init` and never creates `.atl` or `.codegraph`. The CLI entry is guarded by
 * `import.meta.main`, so importing the helpers registers nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureWorktreeProjectDir,
  planWorktreeTarget,
  updateProfile,
} from "../../scripts/register-project.ts";

const HOME = "/home/tester";

describe("planWorktreeTarget", () => {
  test("splits <root>/<project> into the root to register and the project folder", () => {
    expect(planWorktreeTarget(`${HOME}/ai-workspace/worktrees/workflow_optimisation`, HOME)).toEqual({
      root: `${HOME}/ai-workspace/worktrees`,
      project: "workflow_optimisation",
    });
  });

  test("accepts the project names the broker accepts", () => {
    expect(planWorktreeTarget(`${HOME}/wt/a.b-c_1`, HOME)).toEqual({ root: `${HOME}/wt`, project: "a.b-c_1" });
  });

  test.each([
    ["relative path", "ai-workspace/worktrees/p"],
    ["traversal in the name", `${HOME}/wt/..`],
    ["dot name", `${HOME}/wt/.`],
    ["uppercase name", `${HOME}/wt/Proj`],
    ["name starting with a digit", `${HOME}/wt/1proj`],
    ["name with a space", `${HOME}/wt/my proj`],
    ["name with shell-active characters", `${HOME}/wt/p;rm`],
    ["root is $HOME itself", `${HOME}/proj`],
    ["root is the filesystem root", "/proj"],
    ["root under a credential directory", `${HOME}/.ssh/proj`],
    ["root under .config", `${HOME}/.config/wt/proj`],
    ["root under /tmp", "/tmp/wt/proj"],
    ["root under /etc", "/etc/wt/proj"],
  ])("refuses %s", (_label, target) => {
    expect(planWorktreeTarget(target, HOME)).toHaveProperty("error");
  });
});

describe("ensureWorktreeProjectDir", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "wtroot-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("creates the root and the project folder, and nothing else", () => {
    const plan = { root: join(base, "worktrees"), project: "proj" };
    expect(ensureWorktreeProjectDir(plan, false)).toBe("created");
    expect(existsSync(join(plan.root, "proj"))).toBe(true);
    expect(existsSync(join(plan.root, ".git"))).toBe(false);
    expect(existsSync(join(plan.root, ".atl"))).toBe(false);
    expect(existsSync(join(plan.root, ".codegraph"))).toBe(false);
  });

  test("is idempotent and keeps existing worktrees", () => {
    const plan = { root: join(base, "worktrees"), project: "proj" };
    mkdirSync(join(plan.root, "proj", "feature-x"), { recursive: true });
    expect(ensureWorktreeProjectDir(plan, false)).toBe("exists");
    expect(existsSync(join(plan.root, "proj", "feature-x"))).toBe(true);
  });

  test("a dry run creates nothing", () => {
    const plan = { root: join(base, "worktrees"), project: "proj" };
    expect(ensureWorktreeProjectDir(plan, true)).toBe("would create");
    expect(existsSync(plan.root)).toBe(false);
  });

  test("refuses to create the project folder through a symlink that leaves the root", () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    mkdirSync(join(base, "worktrees"));
    const plan = { root: join(base, "worktrees"), project: "proj" };
    // proj already exists as a symlink to a directory outside the root
    require("node:fs").symlinkSync(outside, join(plan.root, "proj"));
    expect(() => ensureWorktreeProjectDir(plan, false)).toThrow(/outside|symlink/i);
  });
});

describe("the root registers like any project grant (read only, V1 and V2 share the helper)", () => {
  test("updateProfile adds the root once to filesystem.read", () => {
    const base = mkdtempSync(join(tmpdir(), "wtprofile-"));
    try {
      const profile = join(base, "profile.json");
      writeFileSync(profile, JSON.stringify({ filesystem: { read: [] } }));
      const root = join(base, "worktrees");
      mkdirSync(root);
      expect(updateProfile(root, profile)).toBe("added");
      expect(updateProfile(root, profile)).toBe("already registered");
      const read = JSON.parse(readFileSync(profile, "utf8")).filesystem.read as string[];
      expect(read.filter((p) => p.endsWith("worktrees"))).toHaveLength(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
