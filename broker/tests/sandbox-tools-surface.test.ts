import { afterAll, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

// Characterization of the V1 plugin surface (P0, docs/upgrades/opencode-v2.md): the registered
// tool names, their order, descriptions and argument keys must not change while the tool logic
// moves into the host-neutral table. Regenerate the fixture only for an intended surface change:
//   SANDBOX_TOOLS_SURFACE_WRITE=1 bun test tests/sandbox-tools-surface.test.ts
const schema = new Proxy({}, { get: () => () => schema });
mock.module("@opencode-ai/plugin", () => ({ tool: (definition: unknown) => definition }));
mock.module("zod", () => ({ z: new Proxy({}, { get: () => () => schema }) }));
afterAll(() => mock.restore());

const FIXTURE = `${import.meta.dir}/fixtures/sandbox-tools-surface.json`;

async function surface() {
  const { default: plugin } = await import("../../opencode/plugins/sandbox-tools.ts");
  const hooks = plugin() as { tool: Record<string, { description: string; args: Record<string, unknown>; execute: unknown }> };
  return {
    hooks: Object.keys(hooks).sort(),
    tools: Object.entries(hooks.tool).map(([name, t]) => ({
      name,
      description: t.description,
      args: Object.keys(t.args),
      execute: typeof t.execute,
      // approval prompts the tool body can raise; a dropped ctx.ask would silently remove a gate
      asks: (String(t.execute).match(/ctx\.ask\(/g) ?? []).length,
    })),
  };
}

test("V1 plugin tool surface matches the recorded baseline", async () => {
  const actual = await surface();
  if (process.env.SANDBOX_TOOLS_SURFACE_WRITE === "1") {
    await Bun.write(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
  }
  expect(actual).toEqual(JSON.parse(readFileSync(FIXTURE, "utf-8")));
});

test("positive control: the surface check can see a changed tool", async () => {
  const actual = await surface();
  const mutated = structuredClone(actual);
  mutated.tools[0].description += " x";
  expect(mutated).not.toEqual(actual);
  const dropped = { ...actual, tools: actual.tools.slice(1) };
  expect(dropped.tools.length).toBe(actual.tools.length - 1);
});

test("the recorded baseline lists every expected tool group", () => {
  const names = JSON.parse(readFileSync(FIXTURE, "utf-8")).tools.map((t: { name: string }) => t.name);
  for (const required of ["sandbox_read", "sandbox_apply", "host_git_commit", "host_review_start", "host_register_project"]) {
    expect(names).toContain(required);
  }
  expect(names.length).toBe(42);
});

test("approval prompts are preserved: 20 ctx.ask call sites, as in the pre-P0 plugin (the 21st grep hit was a header comment)", () => {
  const tools = JSON.parse(readFileSync(FIXTURE, "utf-8")).tools as { name: string; asks: number }[];
  expect(tools.reduce((sum, t) => sum + t.asks, 0)).toBe(20);
  const gated = tools.filter((t) => t.asks > 0).map((t) => t.name);
  for (const required of ["sandbox_apply", "sandbox_copy_out", "sandbox_copy_in", "host_git_commit", "host_git_push", "host_register_project"]) {
    expect(gated).toContain(required);
  }
});
