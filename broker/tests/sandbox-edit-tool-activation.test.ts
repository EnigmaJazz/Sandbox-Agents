import { expect, mock, test } from "bun:test";

const schema = new Proxy({}, { get: () => () => schema });
mock.module("@opencode-ai/plugin", () => ({ tool: (definition: unknown) => definition }));
mock.module("zod", () => ({
  z: new Proxy({}, { get: () => () => schema }),
}));

const operations: string[] = [];
let workerActive = false;
mock.module("../../opencode/plugins/lib/broker-client.ts", () => ({
  brokerSocketPath: () => "/tmp/sandbox-edit-activation.sock",
  createBrokerClient: async () => ({
    request: async (operation: string) => {
      operations.push(operation);
      if (operation === "ensureWorker") {
        workerActive = true;
        return { workerName: "worker-fresh-edit-session" };
      }
      if (operation === "readFile") {
        if (!workerActive) throw new Error("fresh session has no worker recorded — fail closed");
        return { content: "before" };
      }
      if (operation === "writeFile") return { path: "sample.md" };
      throw new Error(`unexpected broker operation: ${operation}`);
    },
  }),
}));

const { default: sandboxToolsPlugin } = await import("../../opencode/plugins/sandbox-tools.ts");

 test("sandbox_edit succeeds when it is the first worker-touching operation", async () => {
  operations.length = 0;
  workerActive = false;
  const tools = sandboxToolsPlugin().tool as Record<string, { execute: (args: unknown, ctx: unknown) => Promise<unknown> }>;

  await tools.sandbox_edit.execute(
    { path: "sample.md", oldString: "before", newString: "after" },
    { sessionID: "fresh-edit-session", directory: "/repo", agent: "general" },
  );

  expect(operations).toEqual(["ensureWorker", "readFile", "writeFile"]);
  expect(workerActive).toBe(true);
});
