/**
 * gentle-ai 4 pre-upgrade step 2: the five host_sdd_* plugin tools are only
 * registered when OPENCODE_SANDBOX_LEGACY_SDD=1, with unchanged argument
 * schemas; every other tool is unaffected. Plan: docs/upgrades/gentle-ai-4.md.
 */
import { afterEach, expect, mock, test } from "bun:test";

const schema = new Proxy({}, { get: () => () => schema });
mock.module("@opencode-ai/plugin", () => ({ tool: (definition: unknown) => definition }));
mock.module("zod", () => ({ z: new Proxy({}, { get: () => () => schema }) }));

const { default: sandboxToolsPlugin } = await import("../../opencode/plugins/sandbox-tools.ts");
const { LEGACY_SDD_ENV, LEGACY_SDD_TOOL_NAMES, legacySddToolsEnabled } = await import(
  "../../opencode/plugins/lib/legacy-sdd-tools.ts"
);

const EXPECTED_ARGS: Record<string, string[]> = {
  host_sdd_status: ["change", "contract"],
  host_sdd_continue: ["change"],
  host_sdd_task_result: ["input", "phase"],
  host_sdd_attempt_grant: ["actor", "change", "changeInstance", "expectedRevision", "reason", "requestId", "roots"],
  host_sdd_archive_compose: ["canonical", "delta", "output"],
};

const saved = process.env[LEGACY_SDD_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[LEGACY_SDD_ENV];
  else process.env[LEGACY_SDD_ENV] = saved;
});

function toolNames(): string[] {
  return Object.keys((sandboxToolsPlugin() as { tool: Record<string, unknown> }).tool);
}

test("the legacy set is exactly the five host_sdd_* tools", () => {
  expect([...LEGACY_SDD_TOOL_NAMES].sort()).toEqual(Object.keys(EXPECTED_ARGS).sort());
});

test("by default no host_sdd_* tool is registered", () => {
  delete process.env[LEGACY_SDD_ENV];
  expect(toolNames().filter((name) => name.startsWith("host_sdd_"))).toEqual([]);
});

test("only the exact value 1 enables them", () => {
  for (const value of ["true", "yes", "on", "0", ""]) {
    expect(legacySddToolsEnabled({ [LEGACY_SDD_ENV]: value })).toBe(false);
  }
  expect(legacySddToolsEnabled({ [LEGACY_SDD_ENV]: "1" })).toBe(true);
  expect(legacySddToolsEnabled({})).toBe(false);
});

test("with the flag set, exactly the five return and nothing else changes", () => {
  delete process.env[LEGACY_SDD_ENV];
  const dormant = toolNames();
  process.env[LEGACY_SDD_ENV] = "1";
  const enabled = toolNames();
  expect(enabled.filter((name) => !dormant.includes(name)).sort()).toEqual(Object.keys(EXPECTED_ARGS).sort());
  expect(dormant.every((name) => enabled.includes(name))).toBe(true);
  expect(enabled.length).toBe(dormant.length + 5);
});

test("legacy tool argument schemas are unchanged", () => {
  process.env[LEGACY_SDD_ENV] = "1";
  const tools = (sandboxToolsPlugin() as { tool: Record<string, { args: Record<string, unknown> }> }).tool;
  for (const [name, args] of Object.entries(EXPECTED_ARGS)) {
    expect(Object.keys(tools[name]!.args).sort()).toEqual(args);
  }
});
