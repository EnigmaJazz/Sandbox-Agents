/**
 * Gate deterministic checks (multi-tier S98-S100): code decides scope, test exit
 * status and the diff-line budget BEFORE any classifier. Pure; NOT installed:
 * S17 security component (broker/src/**), the OWNER reviews and installs it.
 * Missing evidence is never a pass (fail closed): it is reported as `missing`.
 * The budget reuses the existing reviewable-line rule: maxApplyDiffLines
 * (config.resource) over source-code targets, via copy-review.isSourceCodeTarget
 * (diff-spec.ts only holds pathspec excludes; it has no budget logic).
 */
import { isSourceCodeTarget } from "./copy-review.ts";
import type { NumstatEntry } from "./sandbox-result.ts";

export interface GateCheck {
  check: "scope" | "tests" | "budget";
  passed: boolean;
  /** True when the evidence was absent or unusable: unsure, not a clear failure. */
  missing?: boolean;
  detail: string;
}

export interface DeterministicResult {
  checks: GateCheck[];
  deterministicPass: boolean;
}

const fail = (check: GateCheck["check"], detail: string, missing = false): GateCheck => ({
  check,
  passed: false,
  ...(missing ? { missing } : {}),
  detail,
});

/** `*` = within one segment, `**` = across segments; everything else is literal. */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else out += "[^/]*";
    } else out += c.replace(/[\\^$.|?+()[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const unsafePath = (p: unknown): boolean =>
  typeof p !== "string" || p === "" || p.startsWith("/") || p.includes("\0") || p.split("/").includes("..");

export function checkScope(touched: readonly string[] | undefined, allowed: readonly string[] | undefined): GateCheck {
  if (!touched || !allowed || allowed.length === 0) return fail("scope", "touched paths or allowed patterns missing", true);
  if (allowed.some(unsafePath)) return fail("scope", "malformed allowed pattern", true);
  const res = allowed.map(globToRegExp);
  const out = touched.filter((p) => unsafePath(p) || !res.some((re) => re.test(p)));
  return out.length === 0
    ? { check: "scope", passed: true, detail: `${touched.length} path(s) in scope` }
    : fail("scope", `out of scope: ${out.join(", ")}`);
}

export function checkTests(
  results: readonly { command: string; exitCode: number }[] | undefined,
  required: readonly string[] | undefined,
): GateCheck {
  if (!results || !required || required.length === 0) return fail("tests", "test results or required commands missing", true);
  const bad: string[] = [];
  for (const cmd of required) {
    const r = results.filter((x) => x.command === cmd);
    if (r.length === 0) return fail("tests", `no result for required command: ${cmd}`, true);
    if (r.some((x) => x.exitCode !== 0)) bad.push(cmd);
  }
  return bad.length === 0
    ? { check: "tests", passed: true, detail: "all required commands exited 0" }
    : fail("tests", `nonzero exit: ${bad.join(", ")}`);
}

export function checkBudget(entries: readonly NumstatEntry[] | undefined, maxApplyDiffLines: number): GateCheck {
  if (!entries || !Number.isInteger(maxApplyDiffLines) || maxApplyDiffLines < 0) return fail("budget", "diff stats or limit missing", true);
  let total = 0;
  for (const e of entries) {
    if (!isSourceCodeTarget(e.path)) continue;
    if (e.added === null || e.removed === null) return fail("budget", `no line count for ${e.path}`, true);
    total += e.added + e.removed;
  }
  return total <= maxApplyDiffLines
    ? { check: "budget", passed: true, detail: `${total} <= ${maxApplyDiffLines} source lines` }
    : fail("budget", `${total} > ${maxApplyDiffLines} maxApplyDiffLines`);
}

export function runDeterministicChecks(i: {
  touchedPaths?: readonly string[];
  allowedPaths?: readonly string[];
  testResults?: readonly { command: string; exitCode: number }[];
  requiredCommands?: readonly string[];
  numstat?: readonly NumstatEntry[];
  maxApplyDiffLines: number;
}): DeterministicResult {
  const checks = [
    checkScope(i.touchedPaths, i.allowedPaths),
    checkTests(i.testResults, i.requiredCommands),
    checkBudget(i.numstat, i.maxApplyDiffLines),
  ];
  return { checks, deterministicPass: checks.every((c) => c.passed) };
}
