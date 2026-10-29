/**
 * Host-neutral tool table: hostRegisterToolSpecs (P0, docs/upgrades/opencode-v2.md).
 * Plain tool specs, no OpenCode plugin API. The V1 adapter (sandbox-tools.ts) wraps them with tool().
 */
import { z } from "zod";
import {
  buildRegisterProjectAsk,
} from "./host-tool-approval.ts";
import {
  defineTool,
  client,
  pathArg,
} from "./tool-runtime.ts";

export const hostRegisterToolSpecs = {
  host_register_project: defineTool({
    description: "Register a new project with the agentic sandbox system (host-side, creates .atl, updates profile/broker/launcher). Path must be absolute.",
    args: { path: pathArg, dryRun: z.boolean().optional(), createRemote: z.boolean().optional(), makePublic: z.boolean().optional() },
    execute: async (args, ctx) => {
      await ctx.ask(
        buildRegisterProjectAsk({
          path: args.path,
          dryRun: !!args.dryRun,
          createRemote: !!args.createRemote,
          makePublic: !!args.makePublic,
        }),
      );
      const c = await client();
      const result = await c.request("registerProject", ctx.sessionID, { path: args.path, dryRun: !!args.dryRun, createRemote: !!args.createRemote, makePublic: !!args.makePublic }, ctx.agent);
      return JSON.stringify(result, null, 2);
    },
  }),

  // gentle-ai 4 retired SDD: the five host_sdd_* tools are dormant unless
  // OPENCODE_SANDBOX_LEGACY_SDD=1 (rollback to 3.x). See lib/legacy-sdd-tools.ts.
};
