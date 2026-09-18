/**
 * Git snapshot / result boundary unit tests (SYSTEM_PROMPT.md §17-§20, S16).
 *
 * Gate 1 scope: only the PURE parts are exercised — ref naming, plan argv
 * construction (no shell strings), raw-diff classification, protected-path
 * rejection (S7/S17), symlink/submodule rejection, and the divergence
 * comparison. Nothing here touches a real repository's git state.
 */
import { describe, expect, test } from "bun:test";
import { ValidationError } from "../src/validation.ts";
import {
  BASELINE_REF_PREFIX,
  RESULT_REF_PREFIX,
  baselineRef,
  resultRef,
  buildSnapshotPlan,
  buildResultImportPlan,
  buildDiffArgv,
  buildApplyArgv,
  buildCheckArgv,
  classifyRawDiff,
  checkProtectedPaths,
  buildGitCommitArgv,
  buildGitPushArgv,
  buildGhIssueCreateArgv,
  capAndRedact,
  GIT_OUTPUT_MAX_BYTES,
  globMatch,
  computeDivergence,
  parseLsTreeLines,
  parseLsFilesLines,
  patchPathFor,
  bundlePathFor,
} from "../src/gitops.ts";
import { DEFAULT_PROTECTED_PATHS, DEFAULT_PROTECTED_SECURITY_FILES } from "../src/config.ts";

describe("ref naming (§17-§18)", () => {
  test("baseline and result refs live in the sandbox namespace", () => {
    expect(baselineRef("sess123")).toBe(`${BASELINE_REF_PREFIX}/sess123`);
    expect(resultRef("sess123")).toBe(`${RESULT_REF_PREFIX}/sess123`);
  });

  test("rejects unsafe session IDs as ref components", () => {
    for (const bad of ["a/b", "a..b", "a b", "@{x}", "-x", "a~b", "a^b", "a:b", "-"]) {
      expect(() => baselineRef(bad)).toThrow(ValidationError);
      expect(() => resultRef(bad)).toThrow(ValidationError);
    }
  });
});

describe("snapshot plan (§17) — never touches the user's index/branch", () => {
  const plan = buildSnapshotPlan("/repo/.git", "/tmp/index", "sess123", "opencode-sandbox <sandbox@local>");

  test("uses a temporary GIT_INDEX_FILE", () => {
    expect(plan.env.GIT_INDEX_FILE).toBe("/tmp/index");
    expect(plan.env.GIT_DIR).toBe("/repo/.git");
  });

  test("every step is an argv vector with no shell strings", () => {
    for (const step of plan.argvSteps) {
      expect(Array.isArray(step)).toBe(true);
      for (const token of step) {
        expect(token.includes(";") || token.includes("&&") || token.includes("|")).toBe(false);
      }
    }
  });

  test("stages with `git add -A` into the temp index and commit-tree with HEAD parent", () => {
    const add = plan.argvSteps[0];
    expect(add).toEqual(["git", "add", "-A", "--"]);
    const commitTree = plan.argvSteps[2];
    expect(commitTree[0]).toBe("git");
    expect(commitTree[1]).toBe("commit-tree");
    expect(commitTree).toContain("-p");
    expect(commitTree).toContain("HEAD");
  });

  test("publishes under refs/opencode-sandbox/baseline and bundles it", () => {
    const update = plan.argvSteps[3];
    expect(update[0]).toBe("git");
    expect(update[1]).toBe("update-ref");
    expect(update[2]).toBe(`${BASELINE_REF_PREFIX}/sess123`);
    const bundle = plan.argvSteps[4];
    expect(bundle[1]).toBe("bundle");
    expect(bundle[2]).toBe("create");
  });

  test("result import verifies and fetches only into the sandbox namespace", () => {
    const imp = buildResultImportPlan("/repo/.git", "/tmp/r.bundle", "sess123");
    expect(imp.argvSteps[0]).toEqual(["git", "bundle", "verify", "/tmp/r.bundle"]);
    const fetch = imp.argvSteps[1];
    expect(fetch[1]).toBe("fetch");
    expect(fetch.some((t) => t.includes(`${RESULT_REF_PREFIX}/sess123:${RESULT_REF_PREFIX}/sess123`))).toBe(true);
    // The user's branch must never appear in the plan.
    const all = imp.argvSteps.flat().join(" ");
    expect(all).not.toMatch(/\s(master|main|HEAD:)\b/);
  });

  test("apply plan is working-tree only (git apply, no index/branch ops)", () => {
    const applySteps = buildApplyArgv(`${BASELINE_REF_PREFIX}/sess123`, `${RESULT_REF_PREFIX}/sess123`, "/tmp/p.patch");
    const flat = applySteps.flat();
    expect(flat).toContain("apply");
    expect(flat).toContain("--check");
    expect(flat.join(" ")).not.toMatch(/\b(checkout|reset|merge|stash|branch)\b/);
    expect(buildCheckArgv("/tmp/p.patch")).toEqual(["git", "apply", "--check", "/tmp/p.patch"]);
    expect(() => buildCheckArgv("a\u0000b")).toThrow(ValidationError);
  });

  test("state-dir artifact paths are session-scoped", () => {
    expect(patchPathFor("/state", "s1")).toBe("/state/patches/s1.patch");
    expect(bundlePathFor("/state", "s1")).toBe("/state/bundles/s1.bundle");
  });

  test("diff path discovery is NUL-safe and disables rename detection", () => {
    expect(buildDiffArgv(`${BASELINE_REF_PREFIX}/sess123`, `${RESULT_REF_PREFIX}/sess123`)).toContainEqual([
      "git",
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      `${BASELINE_REF_PREFIX}/sess123`,
      `${RESULT_REF_PREFIX}/sess123`,
      "--",
      ".",
    ]);
  });
});

describe("raw diff classification (§19.2-5)", () => {
  test("classifies added/modified/deleted", () => {
    const changes = classifyRawDiff([
      ":000000 100644 0000000000000000000000000000000000000000 3f2c1e8a8a A\tnewfile.ts",
      ":100644 100644 1111111111111111111111111111111111111111 222222222222 M\tmod.ts",
      ":100644 000000 3333333333333333333333333333333333333333 000000000000 D\tgone.ts",
    ]);
    expect(changes.map((c) => c.path)).toEqual(["newfile.ts", "mod.ts", "gone.ts"]);
    expect(changes[0]?.kind).toBe("added");
    expect(changes[1]?.kind).toBe("modified");
    expect(changes[2]?.kind).toBe("deleted");
  });

  test("flags symlink and submodule changes for rejection", () => {
    const changes = classifyRawDiff([
      ":000000 120000 0000000000000000000000000000000000000000 111111111111 A\tlink",
      ":000000 160000 0000000000000000000000000000000000000000 222222222222 A\tsub",
    ]);
    expect(changes[0]?.kind).toBe("symlink");
    expect(changes[1]?.kind).toBe("submodule");
  });
});

describe("protected paths (S7/S17, §19.3)", () => {
  test("rejects S7 credential paths", () => {
    const rejected = checkProtectedPaths(
      ["src/app.ts", ".ssh/id_rsa", ".local/share/opencode/auth.json", "aws/credentials"],
      DEFAULT_PROTECTED_PATHS,
    );
    expect(rejected).toEqual([".ssh/id_rsa", ".local/share/opencode/auth.json"]);
  });

  test("rejects S17 security components", () => {
    const rejected = checkProtectedPaths(
      ["broker/src/server.ts", "nono/profile/opencode-secure.json", "src/main.ts", "docs/readme.md"],
      DEFAULT_PROTECTED_SECURITY_FILES,
    );
    expect(rejected).toEqual([
      "broker/src/server.ts",
      "nono/profile/opencode-secure.json",
    ]);
  });

  test("glob matching: ** crosses directories, * does not", () => {
    expect(globMatch("**/.ssh/**", "a/b/.ssh/x")).toBe(true);
    expect(globMatch("**/.ssh/**", ".ssh/id_rsa")).toBe(true);
    expect(globMatch("**/*.key", "certs/private.key")).toBe(true);
    expect(globMatch("broker/src/**", "broker/src/server.ts")).toBe(true);
    expect(globMatch("broker/src/**", "broker/other.ts")).toBe(false);
    expect(globMatch("**/.env*", ".env.local")).toBe(true);
  });
});

describe("host git commit argv (§31) — ref-scoped, never sweeps", () => {
  const paths = ["broker/src/a.ts", "opencode/plugins/b.ts"];

  test("stages and commits ONLY the given paths with explicit `-- <paths>`", () => {
    const steps = buildGitCommitArgv({ paths, message: "fix: scoped" });
    expect(steps).toEqual([
      ["git", "add", "--", ...paths],
      ["git", "commit", "-m", "fix: scoped", "--", ...paths],
    ]);
    const flat = steps.flat();
    expect(steps[1]!.filter((t) => t === "-m")).toHaveLength(1);
    expect(flat).not.toContain("-A");
    expect(flat).not.toContain("-a");
  });

  test("rejects an empty path set (empty B→C result)", () => {
    expect(() => buildGitCommitArgv({ paths: [], message: "m" })).toThrow(ValidationError);
  });

  test("rejects unsafe paths (absolute/traversal/magic/flag-like)", () => {
    const bad = [["/etc/passwd"], ["../x"], ["a/../../b"], ["--all"], [":(glob)*"], ["a\\b"]];
    for (const entry of bad) {
      expect(() => buildGitCommitArgv({ paths: entry, message: "m" })).toThrow(ValidationError);
    }
  });

  test("message is bounded, flag-safe, control-free", () => {
    expect(() => buildGitCommitArgv({ paths, message: "" })).toThrow(ValidationError);
    expect(() => buildGitCommitArgv({ paths, message: "-x" })).toThrow(ValidationError);
    expect(() => buildGitCommitArgv({ paths, message: "a\nb" })).toThrow(ValidationError);
    expect(() => buildGitCommitArgv({ paths, message: "x".repeat(4097) })).toThrow(ValidationError);
  });
});

describe("host git push argv (§31) — guarded", () => {
  const base = {
    branch: "feature/x",
    upstream: "origin/feature/x",
    ahead: 2,
    remote: "origin",
    setUpstream: false,
    allowProtectedBranch: false,
  };

  test("emits only `git push <remote> <branch>`", () => {
    expect(buildGitPushArgv(base)).toEqual(["git", "push", "origin", "feature/x"]);
  });

  test("adds --set-upstream only when requested", () => {
    expect(buildGitPushArgv({ ...base, setUpstream: true })).toEqual([
      "git",
      "push",
      "--set-upstream",
      "origin",
      "feature/x",
    ]);
  });

  test("refuses detached HEAD", () => {
    expect(() => buildGitPushArgv({ ...base, branch: null })).toThrow(ValidationError);
  });

  test("refuses a missing upstream without setUpstream, allows it with", () => {
    expect(() => buildGitPushArgv({ ...base, upstream: null })).toThrow(ValidationError);
    expect(buildGitPushArgv({ ...base, upstream: null, setUpstream: true })).toEqual([
      "git",
      "push",
      "--set-upstream",
      "origin",
      "feature/x",
    ]);
  });

  test("refuses direct main/master without allowProtectedBranch", () => {
    for (const branch of ["main", "master"]) {
      expect(() => buildGitPushArgv({ ...base, branch })).toThrow(ValidationError);
      expect(buildGitPushArgv({ ...base, branch, allowProtectedBranch: true })).toEqual([
        "git",
        "push",
        "origin",
        branch,
      ]);
    }
  });

  test("refuses force/force-with-lease/delete/+refspec shapes", () => {
    for (const remote of ["--force", "+origin", ":origin", "origin:main"]) {
      expect(() => buildGitPushArgv({ ...base, remote })).toThrow(ValidationError);
    }
    for (const branch of ["--force-with-lease", "--delete", "+main", ":main", "a..b"]) {
      expect(() => buildGitPushArgv({ ...base, branch })).toThrow(ValidationError);
    }
  });
});

describe("host gh issue argv (§31) — fixed argv and caps", () => {
  test("emits exactly `gh issue create --repo --title --body`", () => {
    expect(
      buildGhIssueCreateArgv({ repo: "owner/repo", title: "Bug", body: "line1\nline2" }),
    ).toEqual([
      "gh",
      "issue",
      "create",
      "--repo",
      "owner/repo",
      "--title",
      "Bug",
      "--body",
      "line1\nline2",
    ]);
  });

  test("rejects malformed or oversized values", () => {
    expect(() => buildGhIssueCreateArgv({ repo: "noslash", title: "t", body: "b" })).toThrow(ValidationError);
    expect(() => buildGhIssueCreateArgv({ repo: "-x/y", title: "t", body: "b" })).toThrow(ValidationError);
    expect(() => buildGhIssueCreateArgv({ repo: "o/r", title: "-t", body: "b" })).toThrow(ValidationError);
    expect(() => buildGhIssueCreateArgv({ repo: "o/r", title: "x".repeat(257), body: "b" })).toThrow(ValidationError);
    expect(() => buildGhIssueCreateArgv({ repo: "o/r", title: "t", body: "x".repeat(65537) })).toThrow(ValidationError);
    expect(() => buildGhIssueCreateArgv({ repo: "o/r", title: "t", body: "bad\u0000body" })).toThrow(ValidationError);
  });
});

describe("host git/gh output cap and redaction (§26)", () => {
  test("redacts secret-shaped data and caps at 512 KiB", () => {
    expect(capAndRedact("x token=abcdef123456")).toContain("token=REDACTED");
    const huge = "a".repeat(GIT_OUTPUT_MAX_BYTES + 10);
    expect(Buffer.byteLength(capAndRedact(huge), "utf8")).toBeLessThanOrEqual(GIT_OUTPUT_MAX_BYTES);
  });
});

describe("S16 divergence detection", () => {
  const baseline = new Map([
    ["src/a.ts", "aaa"],
    ["src/b.ts", "bbb"],
    ["README.md", "rrr"],
  ]);

  test("identical trees produce no divergence", () => {
    const current = new Map(baseline);
    expect(computeDivergence(baseline, current)).toEqual([]);
  });

  test("content change is detected", () => {
    const current = new Map(baseline);
    current.set("src/a.ts", "a2");
    expect(computeDivergence(baseline, current)).toEqual(["src/a.ts"]);
  });

  test("added/removed files are detected", () => {
    const current = new Map(baseline);
    current.delete("src/b.ts");
    current.set("NEW.md", "new");
    expect(computeDivergence(baseline, current)).toEqual(["NEW.md", "src/b.ts"]);
  });

  test("parses git ls-tree / ls-files output shapes", () => {
    const tree = parseLsTreeLines(["100644 blob aaa\tREADME.md", "100644 blob bbb\tsrc/a.ts"]);
    expect(tree.get("README.md")).toBe("aaa");
    const files = parseLsFilesLines(["100644 bbb 0\tsrc/a.ts"]);
    expect(files.get("src/a.ts")).toBe("bbb");
  });
});
