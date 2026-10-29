/**
 * Stage A sandbox tools plugin (SYSTEM_PROMPT.md §12, §11, §28).
 *
 * Exposes the explicit `sandbox_*` tool family through the opencode 1.18.x
 * `tool` hook. Custom tools are declared by plugins in this version; there
 * are no .ts files under opencode/tools/ (see plugins/README.md).
 *
 * Lazy activation (§11): mutation tools (sandbox_write / sandbox_edit /
 * sandbox_apply_patch / sandbox_bash) call ensureWorker first; read tools do
 * NOT create a worker and fail with a clear error when none exists.
 *
 * sandbox_bash is NOT a shell: the command string is tokenized (whitespace +
 * quotes only) and every token is re-validated broker-side against the
 * §28 attack table. No globbing, expansion, redirection or pipes.
 *
 * sandbox_apply normally requires human approval via ctx.ask() before the
 * broker may apply the B->C delta (S15, §19.9).
 * sandbox_copy_out / sandbox_copy_in move
 * single files between the worker and the host under the same approval gate
 * (S15): the broker verifies the host path against the
 * BROKER_EXTERNAL_COPY_TARGETS allowlist before showing a preview and
 * requesting confirmation.
 *
 * Gate 1: NOT installed. Wiring is verified at Gate 4 against the installed
 * opencode 1.18.x plugin API (typings at ~/.opencode/node_modules/@opencode-ai/plugin).
 */
import { tool } from "@opencode-ai/plugin";
import {
  type HostToolSpec,
  client,
  untrackedInventoryArg,
  currentProjectDirectory,
} from "./lib/tool-runtime.ts";
import { hostRegisterToolSpecs } from "./lib/tool-specs-host-register.ts";
import {
  reviewCaptureToolSpecs,
} from "./lib/tool-specs-review-capture.ts";
import {
  reviewReadToolSpecs,
} from "./lib/tool-specs-review-read.ts";
import {
  hostOpsToolSpecs,
} from "./lib/tool-specs-host-ops.ts";
import {
  hostResultToolSpecs,
} from "./lib/tool-specs-host-result.ts";
import {
  sandboxToolSpecs,
} from "./lib/tool-specs-sandbox.ts";
import {
  BIND_SESSION_AGENT_OPERATION,
  hostSessionBinding,
} from "./lib/session-agent-binding.ts";
import {
  buildLegacySddTools,
  legacySddToolsEnabled,
} from "./lib/legacy-sdd-tools.ts";

/** V1 adapter: wrap each host-neutral spec with opencode's tool(). */
function toV1Tools(specs: Record<string, HostToolSpec>) {
  return Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, tool(spec as any)]));
}

export default function sandboxToolsPlugin() {
  return {
    tool: {
      ...toV1Tools(sandboxToolSpecs),

      ...toV1Tools(hostResultToolSpecs),

      ...toV1Tools(reviewReadToolSpecs),

      ...toV1Tools(hostOpsToolSpecs),

      ...toV1Tools(reviewCaptureToolSpecs),

      ...toV1Tools(hostRegisterToolSpecs),

      ...(legacySddToolsEnabled()
        ? buildLegacySddTools({
            client,
            projectDirectory: currentProjectDirectory,
            revisionArg: untrackedInventoryArg,
          })
        : {}),
    },
    "chat.params": async (input: unknown) => {
      // Host-authoritative session->agent binding: the broker records who the
      // host says the session is. Authorization remains in the role matrix, so
      // an unknown identity binds and is then denied. Best-effort failure
      // leaves host mutations failing closed rather than blocking the chat.
      const binding = hostSessionBinding(
        input,
        [typeof input === "object" && input !== null && "agent" in input && typeof input.agent === "string" ? input.agent : ""],
      );
      if (!binding) return;
      try {
        const c = await client();
        await c.request(BIND_SESSION_AGENT_OPERATION, binding.sessionID, {
          agent: binding.agent,
        });
      } catch {
        /* unbound sessions cannot run host mutations (fail closed) */
      }
    },
  };
}
