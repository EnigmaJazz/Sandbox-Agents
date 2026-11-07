import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * V5 (docs/upgrades/opencode-v2.md): the V2 config fragments under opencode/plugins-v2/config-fragments/.
 *
 * The security-relevant difference from V1, proved live on OpenCode V2 2.2.0 (opencode-v2-probe, FINDINGS-2):
 * a plugin tool with NO permission rule is silently allowed (the base rule is `* * allow`), whereas V1 asked by
 * default. So every tool must have an explicit rule, and every tool that asks for approval in code must be `ask`.
 */
const ROOT = resolve(import.meta.dir, "../..");
const V1_DIR = resolve(ROOT, "opencode/config-fragments");
const V2_DIR = resolve(ROOT, "opencode/plugins-v2/config-fragments");
const LIB_DIR = resolve(ROOT, "opencode/plugins/lib");

/** Whole-line `//` comments only (the fragments keep comments on their own lines). */
function parseJsonc(path: string): any {
  const text = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  return JSON.parse(text);
}

/** Static scan of the host-neutral tool table: tool name -> does its block ask for approval. */
function scanTools(): Map<string, boolean> {
  const tools = new Map<string, boolean>();
  for (const file of readdirSync(LIB_DIR).filter((f) => /^tool-specs-.*\.ts$/.test(f))) {
    const parts = readFileSync(resolve(LIB_DIR, file), "utf8").split(/\n {2}([a-z_]+): defineTool\(\{/);
    for (let i = 1; i < parts.length; i += 2) tools.set(parts[i]!, /ask\(/.test(parts[i + 1]!));
  }
  return tools;
}

const tools = scanTools();
const v1 = parseJsonc(resolve(V1_DIR, "sandbox-permissions.jsonc")).permission as Record<string, unknown>;
const v2 = parseJsonc(resolve(V2_DIR, "sandbox-permissions.jsonc")).permission as Record<string, unknown>;

describe("tool table scan (positive control: the checks below are not vacuous)", () => {
  test("finds the 53 tools and the 25 that ask for approval", () => {
    expect(tools.size).toBe(53);
    expect([...tools.values()].filter(Boolean).length).toBe(25);
  });
  test("the V1 fragment is known to lack rules for three asking tools", () => {
    const missing = [...tools.keys()].filter((name) => !(name in v1));
    expect(missing.sort()).toEqual(["host_git_clear_commit_intent", "sandbox_copy_in", "sandbox_copy_out"]);
  });
});

describe("V2 permission fragment", () => {
  test("every tool has an explicit rule (no rule means silently allowed on V2)", () => {
    const missing = [...tools.keys()].filter((name) => !(name in v2));
    expect(missing).toEqual([]);
  });

  test("the git HEAD tool is allow in both fragments", () => {
    expect(v1.host_git_head).toBe("allow");
    expect(v2.host_git_head).toBe("allow");
  });

  test("the git branch tool is ask in both fragments", () => {
    expect(v1.host_git_branch).toBe("ask");
    expect(v2.host_git_branch).toBe("ask");
  });

  test("every tool that asks for approval in code is `ask` or `deny`", () => {
    const wrong = [...tools].filter(([name, asks]) => asks && !["ask", "deny"].includes(String(v2[name]))).map(([n]) => n);
    expect(wrong).toEqual([]);
  });

  test("shared tool rules match V1 exactly, except the three V1 left to the old default", () => {
    const added = new Set(["host_git_clear_commit_intent", "sandbox_copy_in", "sandbox_copy_out"]);
    for (const [name, effect] of Object.entries(v1)) {
      if (!/^(sandbox|host)_/.test(name)) continue;
      expect([name, v2[name]]).toEqual([name, effect]);
    }
    for (const name of added) expect(v2[name]).toBe("ask");
  });

  test("the retired SDD tools stay denied", () => {
    const retired = Object.keys(v1).filter((name) => /^host_sdd_/.test(name));
    expect(retired.length).toBeGreaterThan(0);
    for (const name of retired) expect(v2[name]).toBe("deny");
  });

  test("host shell and file mutation are denied under V2's native names", () => {
    expect(v2.shell).toBe("deny");
    expect(v2.edit).toBe("deny");
  });

  test("secret reads are denied through a pattern map (the V1 allow/deny object form is invalid config)", () => {
    const read = v2.read as Record<string, string>;
    expect(typeof read).toBe("object");
    expect(Object.values(read).every((effect) => effect === "deny")).toBe(true);
    const v1Denies = ((v1.read as any).deny as string[]).slice().sort();
    expect(Object.keys(read).sort()).toEqual(v1Denies);
  });

  test("it does not carry V1-only keys that V2 would have to translate", () => {
    for (const key of ["bash", "write", "apply_patch"]) expect(key in v2).toBe(false);
  });
});

describe("V2 role agents fragment", () => {
  const v1Roles = parseJsonc(resolve(V1_DIR, "role-agents.jsonc"));
  const v2Roles = parseJsonc(resolve(V2_DIR, "role-agents.jsonc"));

  test("declares the same agents, models and tool allowlists as V1", () => {
    expect(v2Roles.roleModels).toEqual(v1Roles.roleModels);
    expect(v2Roles.agent).toEqual(v1Roles.agent);
  });

  test("agents stay hidden subagents that cannot spawn subagents, and the allowlist denies everything else", () => {
    for (const [name, agent] of Object.entries<any>(v2Roles.agent)) {
      expect([name, agent.hidden, agent.mode]).toEqual([name, true, "subagent"]);
      expect(agent.tools["*"]).toBe(false);
      expect(agent.permission.task).toEqual({ "*": "deny" });
    }
  });

  test("only the worker holds mutation tools", () => {
    const mutating = ["sandbox_write", "sandbox_edit", "sandbox_apply_patch", "sandbox_bash", "sandbox_apply"];
    expect(mutating.some((t) => v2Roles.agent.researcher.tools[t])).toBe(false);
    expect(mutating.every((t) => v2Roles.agent.worker.tools[t])).toBe(true);
  });
});
