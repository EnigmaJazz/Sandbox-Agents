import { describe, expect, test } from "bun:test";
import routingGuardPlugin from "../../opencode/plugins/routing-guard.ts";

const MUTATION_BLOCK_MSG =
  "Ordinary host mutation/execution tools are disabled in this secured environment (S1/S10). " +
  "Use sandbox_write / sandbox_edit / sandbox_apply_patch / sandbox_bash to work inside your isolated worker.";

type BeforeHook = (input: { tool: string; sessionID: string }, output: { args?: Record<string, unknown> }) => Promise<void>;

function captureBeforeHook(): BeforeHook {
  const plugin = routingGuardPlugin();
  const hook = plugin["tool.execute.before"];
  if (!hook) throw new Error("tool.execute.before hook was not registered");
  return hook as BeforeHook;
}

describe("routing guard tool admission", () => {
  const before = captureBeforeHook();

  for (const tool of ["bash", "write", "edit", "apply_patch", "patch"]) {
    test(`${tool} throws the host-mutation block message`, async () => {
      await expect(
        before({ tool, sessionID: "test-session" }, { args: {} }),
      ).rejects.toThrow(MUTATION_BLOCK_MSG);
    });
  }

  for (const tool of ["ast_grep_replace", "aft_import", "aft_safety"]) {
    test(`${tool} throws the host-mutation block message`, async () => {
      await expect(
        before({ tool, sessionID: "test-session" }, { args: {} }),
      ).rejects.toThrow(MUTATION_BLOCK_MSG);
    });
  }

  for (const tool of ["aft_outline", "aft_search", "unlisted_tool"]) {
    test(`${tool} falls through without throwing`, async () => {
      await expect(
        before({ tool, sessionID: "test-session" }, { args: {} }),
      ).resolves.toBeUndefined();
    });
  }
});
