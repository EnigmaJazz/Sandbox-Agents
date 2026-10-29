import { expect, test } from "bun:test";

// Safety net for the P0 move (docs/upgrades/opencode-v2.md): call every registered tool once with
// a fake broker and assert none fails with a ReferenceError, which is what a helper that did not
// move with its tool would produce. Validation and policy errors are expected and ignored.
// Runs in a subprocess so its module mocks cannot leak into other test files.
async function sweep(): Promise<{ count: number; referenceErrors: string[] }> {
  const source = `
    import { mock } from "bun:test";
    const schema = new Proxy({}, { get: () => () => schema });
    mock.module("@opencode-ai/plugin", () => ({ tool: (definition) => definition }));
    mock.module("zod", () => ({ z: new Proxy({}, { get: () => () => schema }) }));
    mock.module("./opencode/plugins/lib/broker-client.ts", () => ({
      createBrokerClient: async () => ({ request: async () => ({}), close: () => {} }),
      brokerSocketPath: () => "/tmp/unreachable-sweep.sock",
    }));
    const { default: plugin } = await import("./opencode/plugins/sandbox-tools.ts");
    const tools = plugin().tool;
    const ctx = { sessionID: "sweep-session", directory: "/tmp/sweep-project", agent: "sweep-agent", ask: async () => {} };
    const referenceErrors = [];
    for (const name of Object.keys(tools)) {
      try { await tools[name].execute({}, ctx); }
      catch (error) { if (error instanceof ReferenceError) referenceErrors.push(name + ": " + error.message); }
    }
    console.log(JSON.stringify({ count: Object.keys(tools).length, referenceErrors }));
  `;
  const child = Bun.spawn(["bun", "-e", source], { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`sweep probe failed: ${stderr}`);
  return JSON.parse(stdout.trim().split("\n").pop()!);
}

test("every tool body resolves its helpers (no ReferenceError)", async () => {
  const result = await sweep();
  expect(result.count).toBe(42);
  expect(result.referenceErrors).toEqual([]);
});

test("positive control: a ReferenceError is what the sweep looks for", () => {
  let seen = false;
  try { (0, eval)("notDefinedAnywhere123"); } catch (error) { seen = error instanceof ReferenceError; }
  expect(seen).toBe(true);
});
