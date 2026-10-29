/**
 * OpenCode V2 entry for the sandbox tool family (docs/upgrades/opencode-v2.md, workstream V2).
 *
 * A thin adapter: every tool is defined once, host-neutral, in opencode/plugins/lib/tool-specs-*.ts and shared with the
 * V1 plugin (opencode/plugins/sandbox-tools.ts). The mapping rules live in ./lib/v2-adapter.ts (tested in
 * broker/tests/v2-adapter.test.ts); this file only supplies the V2 host pieces: zod for input schemas, the broker
 * client, `ctx.permission.assert` for approvals and `ctx.session.get` for the per-session directory.
 *
 * Not here (other workstreams): the routing guard and system rule (V3), the reviewer relay (V4), config fragments (V5).
 * The legacy SDD tools stay dormant in V2. V1 and V2 must not share a config root (V2 would load V1's plugins/).
 *
 * Gate 1: NOT installed. Delivery is manual (S17): the USER reviews this diff and installs the exact bytes by hand.
 */
import { z } from "zod";
import { client } from "../plugins/lib/tool-runtime.ts";
import { hostRegisterToolSpecs } from "../plugins/lib/tool-specs-host-register.ts";
import { reviewCaptureToolSpecs } from "../plugins/lib/tool-specs-review-capture.ts";
import { reviewReadToolSpecs } from "../plugins/lib/tool-specs-review-read.ts";
import { hostOpsToolSpecs } from "../plugins/lib/tool-specs-host-ops.ts";
import { hostResultToolSpecs } from "../plugins/lib/tool-specs-host-result.ts";
import { sandboxToolSpecs } from "../plugins/lib/tool-specs-sandbox.ts";
import { BIND_SESSION_AGENT_OPERATION, hostSessionBinding } from "../plugins/lib/session-agent-binding.ts";
import { adaptToolSpec, type HostToolSpecLike, type V2AdapterDeps } from "./lib/v2-adapter.ts";

const SPECS: Record<string, HostToolSpecLike> = {
  ...sandboxToolSpecs,
  ...hostResultToolSpecs,
  ...reviewReadToolSpecs,
  ...hostOpsToolSpecs,
  ...reviewCaptureToolSpecs,
  ...hostRegisterToolSpecs,
} as Record<string, HostToolSpecLike>;

interface V2Context {
  location: { directory: string };
  permission: { assert(request: unknown): Promise<unknown> };
  session: { get(input: { sessionID: string }): Promise<{ location?: { directory?: string } } | undefined> };
  tool: {
    transform(fn: (editor: { add(tool: unknown): void }) => void): Promise<unknown>;
  };
}

export default {
  id: "sandbox-tools",
  async setup(ctx: V2Context) {
    const deps: V2AdapterDeps = {
      toInputSchema: (args) => z.object(args as any),
      bindSessionAgent: async (sessionID, agent) => {
        // The host supplies sessionID and agent on every tool call; authorization stays in the broker role matrix.
        const binding = hostSessionBinding({ sessionID, agent }, [agent]);
        if (!binding) return;
        const c = await client();
        await c.request(BIND_SESSION_AGENT_OPERATION, binding.sessionID, { agent: binding.agent });
      },
      assertPermission: (request) => ctx.permission.assert(request),
      sessionDirectory: async (sessionID) => {
        try {
          return (await ctx.session.get({ sessionID }))?.location?.directory ?? ctx.location.directory;
        } catch {
          return ctx.location.directory; // setup runs once per directory, so this is the session's directory
        }
      },
    };
    await ctx.tool.transform((editor) => {
      for (const [name, spec] of Object.entries(SPECS)) editor.add(adaptToolSpec(name, spec, deps));
    });
  },
};
