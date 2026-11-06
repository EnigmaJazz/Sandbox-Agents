import { describe, expect, test } from "bun:test";
import { checkBudget, checkScope, checkSurfaces, checkTests, runDeterministicChecks } from "../src/gate-checks.ts";

describe("gate checks: scope (S98)", () => {
  test("in-scope paths pass; literal and glob patterns", () => {
    expect(checkScope(["a/b.ts", "docs/x/y.md"], ["a/b.ts", "docs/**"]).passed).toBe(true);
    expect(checkScope(["a/b.ts"], ["a/*.ts"]).passed).toBe(true);
  });
  test("an out-of-scope diff fails before any classifier", () => {
    const r = checkScope(["a/b.ts", "evil.ts"], ["a/**"]);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("evil.ts");
  });
  test("single star does not cross segments; regex metacharacters are literal", () => {
    expect(checkScope(["a/b/c.ts"], ["a/*.ts"]).passed).toBe(false);
    expect(checkScope(["axb.ts"], ["a.b.ts"]).passed).toBe(false);
    expect(checkScope(["a(1).ts"], ["a(1).ts"]).passed).toBe(true);
  });
  test("traversal, absolute and empty paths fail", () => {
    for (const p of ["../x", "a/../b", "/etc/passwd", ""]) expect(checkScope([p], ["**"]).passed).toBe(false);
  });
  test("missing evidence fails closed and is marked missing", () => {
    for (const r of [checkScope(undefined, ["a"]), checkScope(["a"], undefined), checkScope(["a"], [])]) {
      expect(r.passed).toBe(false);
      expect(r.missing).toBe(true);
    }
  });
});

describe("gate checks: tests (S99)", () => {
  test("exit 0 for every required command passes", () => {
    expect(checkTests([{ command: "t", exitCode: 0 }], ["t"]).passed).toBe(true);
  });
  test("a nonzero exit fails (clear failure, not missing)", () => {
    const r = checkTests([{ command: "t", exitCode: 1 }], ["t"]);
    expect(r.passed).toBe(false);
    expect(r.missing).toBeUndefined();
  });
  test("a nonzero rerun of a command fails even if another run passed", () => {
    expect(checkTests([{ command: "t", exitCode: 0 }, { command: "t", exitCode: 2 }], ["t"]).passed).toBe(false);
  });
  test("missing result, results or required list fails closed as missing", () => {
    for (const r of [checkTests([], ["t"]), checkTests(undefined, ["t"]), checkTests([], [])]) {
      expect(r.passed).toBe(false);
      expect(r.missing).toBe(true);
    }
  });
});

describe("gate checks: diff-line budget (S100)", () => {
  const e = (path: string, added: number | null, removed: number | null) => ({ path, added, removed });
  test("at the limit passes; over fails", () => {
    expect(checkBudget([e("a.ts", 150, 50)], 200).passed).toBe(true);
    expect(checkBudget([e("a.ts", 150, 51)], 200).passed).toBe(false);
  });
  test("non-source targets do not count (same rule as copy-out review)", () => {
    expect(checkBudget([e("a.md", 900, 0)], 200).passed).toBe(true);
  });
  test("binary or missing stats fail closed as missing", () => {
    expect(checkBudget([e("a.ts", null, null)], 200).missing).toBe(true);
    expect(checkBudget(undefined, 200).missing).toBe(true);
    expect(checkBudget([], -1).missing).toBe(true);
  });
});

describe("gate checks: aggregate", () => {
  const ok = {
    touchedPaths: ["a.ts"], allowedPaths: ["a.ts"],
    testResults: [{ command: "t", exitCode: 0 }], requiredCommands: ["t"],
    numstat: [{ path: "a.ts", added: 1, removed: 1 }], maxApplyDiffLines: 200,
  };
  test("all pass", () => expect(runDeterministicChecks(ok).deterministicPass).toBe(true));
  test("any failure or missing evidence blocks deterministicPass", () => {
    expect(runDeterministicChecks({ ...ok, touchedPaths: ["z.ts"] }).deterministicPass).toBe(false);
    expect(runDeterministicChecks({ ...ok, testResults: [{ command: "t", exitCode: 1 }] }).deterministicPass).toBe(false);
    expect(runDeterministicChecks({ ...ok, numstat: undefined }).deterministicPass).toBe(false);
  });
});

describe("gate checks: plan surfaces (D28, D29)", () => {
  const prot = ["broker/src/role-policy.ts", "docs/secret/**"];
  test("bounded surfaces pass", () => {
    expect(checkSurfaces(["src/**", "docs/*.md"], prot)).toMatchObject({ check: "surfaces", passed: true });
  });
  test("a missing or empty section is unsure, not a failure", () => {
    for (const a of [undefined, []]) expect(checkSurfaces(a, prot)).toMatchObject({ check: "surfaces", passed: false, missing: true });
  });
  test("a repo-wide surface is a clear failure", () => {
    for (const w of ["*", "**", "**/*", "./**"]) {
      const r = checkSurfaces(["src/**", w], prot);
      expect(r.passed, w).toBe(false);
      expect(r.missing, w).toBeUndefined();
    }
  });
  test("every all-wildcard spelling is repo-wide, not only five strings (H1)", () => {
    for (const w of ["**/**", "*/**", "**/*/**", "*/*", "./**/**", ".", "./", "***", "**//**"]) {
      const r = checkSurfaces(["src/**", w], prot);
      expect(r.passed, w).toBe(false);
      expect(r.missing, w).toBeUndefined();
    }
    // Positive control: anchored globs are bounded.
    for (const ok of ["src/**/*.ts", "**/*.ts", "docs/*.md", "a/**/b"]) expect(checkSurfaces([ok], ["docs/secret/**"]).passed, ok).toBe(true);
  });
  test("a glob that can reach a protected path is a clear failure, in both directions (H1)", () => {
    for (const g of ["broker/src/**", "docs/**", "broker/**/*.ts", "**/role-policy.ts", "docs/secret/*"]) {
      const r = checkSurfaces([g], prot);
      expect(r.passed, g).toBe(false);
      expect(r.missing, g).toBeUndefined();
    }
    // Default protected patterns: a surface that can reach credentials or key files.
    const defaults = ["**/.ssh/**", "**/*.key", "**/.env*"];
    for (const g of ["home/.ssh/**", "keys/*.key", "app/.env*"]) expect(checkSurfaces([g], defaults).passed, g).toBe(false);
    for (const ok of ["src/**", "docs/*.md", "keys/*.txt"]) expect(checkSurfaces([ok], defaults).passed, ok).toBe(true);
  });
  test("a malformed or protected surface is a clear failure", () => {
    for (const bad of ["../x", "/etc/passwd", "a/../b", "broker/src/role-policy.ts", "docs/secret/key.md"]) {
      const r = checkSurfaces(["src/**", bad], prot);
      expect(r.passed, bad).toBe(false);
      expect(r.missing, bad).toBeUndefined();
    }
  });
  test("plan-vs-spec runs only the plan-derivable check; implementation-vs-spec is unchanged", () => {
    const plan = runDeterministicChecks({ checkpoint: "plan-vs-spec", allowedPaths: ["src/**"], protectedPatterns: prot, maxApplyDiffLines: 200 });
    expect(plan.checks.map((c) => c.check)).toEqual(["surfaces"]);
    expect(plan.deterministicPass).toBe(true);
    const impl = runDeterministicChecks({ maxApplyDiffLines: 200 });
    expect(impl.checks.map((c) => c.check)).toEqual(["scope", "tests", "budget"]);
  });
});
