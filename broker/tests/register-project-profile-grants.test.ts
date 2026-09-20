/**
 * T3 — profile-grant behaviour for `scripts/register-project.ts`.
 *
 * Drives the exported allow-list grant helpers against a temporary project
 * fixture and a temporary copy of the nono profile. The real profile and the
 * real project tree are never touched: the script's CLI entry point is guarded
 * by `import.meta.main`, so importing it here performs no registration.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  updateCodegraphGrant,
  updateProjectGitGrant,
  updateSkillRegistryGrant,
} from "../../scripts/register-project.ts";

interface TempProfile {
  filesystem?: {
    allow?: string[];
    allow_file?: string[];
    read?: string[];
  };
}

let root: string;
let project: string;
let profilePath: string;

function readProfile(): TempProfile {
  return JSON.parse(readFileSync(profilePath, "utf8")) as TempProfile;
}

function allowEntries(): string[] {
  return readProfile().filesystem?.allow ?? [];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "register-project-grants-"));
  project = join(root, "project");
  mkdirSync(project, { recursive: true });
  profilePath = join(root, "opencode-secure.json");
  writeFileSync(
    profilePath,
    JSON.stringify(
      {
        filesystem: {
          allow: ["/existing/.atl"],
          allow_file: ["/existing/.auto-update-history.json"],
          read: [project],
        },
      },
      null,
      2,
    ) + "\n",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("updateProjectGitGrant (T1)", () => {
  test("grants <project>/.git read-write when the directory exists", () => {
    mkdirSync(join(project, ".git"));
    const result = updateProjectGitGrant(project, profilePath, false);
    expect(result.status).toBe("added");
    expect(result.warning).toBeNull();
    const allow = allowEntries();
    expect(allow).toContain(join(project, ".git"));
    expect(allow.filter((e) => e === join(project, ".git"))).toHaveLength(1);
    // Unrelated grants are preserved untouched.
    expect(allow).toContain("/existing/.atl");
    expect(readProfile().filesystem?.allow_file).toEqual([
      "/existing/.auto-update-history.json",
    ]);
    expect(readProfile().filesystem?.read).toEqual([project]);
  });

  test("skips the grant with a warning when .git is absent", () => {
    expect(existsSync(join(project, ".git"))).toBe(false);
    const result = updateProjectGitGrant(project, profilePath, false);
    expect(result.status).toBe("skipped (no .git directory)");
    expect(result.warning).not.toBeNull();
    expect(result.warning).toContain(".git");
    // Never create .git: a synthesized Git directory would be broken.
    expect(existsSync(join(project, ".git"))).toBe(false);
    expect(allowEntries()).toEqual(["/existing/.atl"]);
  });

  test("is idempotent across repeat runs", () => {
    mkdirSync(join(project, ".git"));
    expect(updateProjectGitGrant(project, profilePath, false).status).toBe(
      "added",
    );
    expect(updateProjectGitGrant(project, profilePath, false).status).toBe(
      "already registered",
    );
    expect(
      allowEntries().filter((e) => e === join(project, ".git")),
    ).toHaveLength(1);
  });

  test("--dry-run adds no entry", () => {
    mkdirSync(join(project, ".git"));
    const result = updateProjectGitGrant(project, profilePath, true);
    expect(result.status.startsWith("would add")).toBe(true);
    expect(allowEntries()).toEqual(["/existing/.atl"]);
  });
});

describe("updateCodegraphGrant (T2, docs/TODO.md item 27)", () => {
  test("creates and grants <project>/.codegraph", () => {
    const result = updateCodegraphGrant(project, profilePath, false);
    expect(result).toBe("added; created");
    expect(existsSync(join(project, ".codegraph"))).toBe(true);
    const allow = allowEntries();
    expect(allow).toContain(join(project, ".codegraph"));
    expect(allow.filter((e) => e === join(project, ".codegraph"))).toHaveLength(
      1,
    );
  });

  test("is idempotent across repeat runs", () => {
    updateCodegraphGrant(project, profilePath, false);
    expect(updateCodegraphGrant(project, profilePath, false)).toBe(
      "already registered",
    );
    expect(
      allowEntries().filter((e) => e === join(project, ".codegraph")),
    ).toHaveLength(1);
  });

  test("--dry-run creates no directory and writes no entry", () => {
    const target = join(project, ".codegraph");
    const result = updateCodegraphGrant(project, profilePath, true);
    expect(result).toBe(`would add ${target}; would create ${target}`);
    expect(existsSync(target)).toBe(false);
    expect(allowEntries()).toEqual(["/existing/.atl"]);
  });
});

describe("existing .atl grant path (unchanged)", () => {
  test("still creates and grants .atl, then reports already registered", () => {
    expect(updateSkillRegistryGrant(project, profilePath, false)).toBe(
      "added; created",
    );
    expect(existsSync(join(project, ".atl"))).toBe(true);
    expect(updateSkillRegistryGrant(project, profilePath, false)).toBe(
      "already registered",
    );
    expect(allowEntries().filter((e) => e === join(project, ".atl"))).toHaveLength(
      1,
    );
  });
});
