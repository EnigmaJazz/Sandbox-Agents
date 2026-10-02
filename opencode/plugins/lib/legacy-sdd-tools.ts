/**
 * Legacy SDD plugin tools (gentle-ai 4 pre-upgrade, docs/upgrades/gentle-ai-4.md).
 *
 * gentle-ai 4.0.0 removed the `sdd-*` subcommands these tools reach through
 * the broker. The definitions are kept whole so a rollback to 3.x is
 * configuration only, but sandbox-tools.ts registers them only when
 * OPENCODE_SANDBOX_LEGACY_SDD=1. Lives under lib/ so the OpenCode loader never
 * treats it as a plugin. The broker gates the same operations independently
 * (broker/src/legacy-sdd.ts), so registering these on gentle-ai 4 still fails
 * closed.
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import type { BrokerClient } from "./broker-client.ts";
import { buildSddArchiveComposeAsk, buildSddAttemptGrantAsk } from "./host-tool-approval.ts";

export const LEGACY_SDD_ENV = "OPENCODE_SANDBOX_LEGACY_SDD";

export const LEGACY_SDD_TOOL_NAMES = [
  "host_sdd_status",
  "host_sdd_continue",
  "host_sdd_task_result",
  "host_sdd_attempt_grant",
  "host_sdd_archive_compose",
] as const;

/** Only the exact value "1" enables the legacy tools; anything else keeps them dormant. */
export function legacySddToolsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[LEGACY_SDD_ENV] === "1";
}

export interface LegacySddToolDeps {
  client: () => Promise<BrokerClient>;
  /** The plugin's canonical project-directory check. */
  projectDirectory: (directory: string | undefined) => string;
  /** The plugin's shared `sha256:<hex>` revision schema. */
  revisionArg: ReturnType<typeof z.string>;
}

const sddIdentifierArg = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).refine((value) => !value.includes(".."));
const sddLowercaseRequestIdArg = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/);
const sddContractArg = z.enum(["gentle-ai.sdd-status/v2"]);
const sddPathArg = z.string().min(1).max(4096);

export function buildLegacySddTools(deps: LegacySddToolDeps) {
  return {
    host_sdd_status: tool({
      description:
        "Run a host-side, allowlisted SDD runtime status operation (read-only; no approval). The " +
        "broker uses the current canonical project root and exact operation-specific argv, never " +
        "sandbox_bash; this tool never accepts arbitrary cwd, binary, or argv and does not activate " +
        "a worker. Returns JSON.",
      args: {
        change: sddIdentifierArg.optional(),
        contract: sddContractArg.optional(),
      },
      execute: async (args, ctx) => {
        const c = await deps.client();
        const result = await c.request("sddStatus", ctx.sessionID, {
          projectDir: deps.projectDirectory(ctx.directory),
          ...(args.change ? { change: args.change } : {}),
          ...(args.contract ? { contract: args.contract } : {}),
        }, ctx.agent);
        return JSON.stringify(result, null, 2);
      },
    }),
    host_sdd_continue: tool({
      description:
        "Run a host-side, allowlisted SDD continue operation (read-only; no approval). Exact " +
        "frozen argv, canonical project root, no worker activation. Returns JSON.",
      args: { change: sddIdentifierArg.optional() },
      execute: async (args, ctx) => {
        const c = await deps.client();
        const result = await c.request("sddContinue", ctx.sessionID, {
          projectDir: deps.projectDirectory(ctx.directory),
          ...(args.change ? { change: args.change } : {}),
        }, ctx.agent);
        return JSON.stringify(result, null, 2);
      },
    }),
    host_sdd_task_result: tool({
      description:
        "Validate a per-phase SDD task result (read-only; no approval). phase is " +
        "the SDD phase id; input is a project-relative path or '-'. Returns JSON.",
      args: { phase: sddIdentifierArg, input: sddPathArg },
      execute: async (args, ctx) => {
        const c = await deps.client();
        const result = await c.request("sddTaskResult", ctx.sessionID, {
          projectDir: deps.projectDirectory(ctx.directory),
          phase: args.phase,
          input: args.input,
        }, ctx.agent);
        return JSON.stringify(result, null, 2);
      },
    }),
    host_sdd_attempt_grant: tool({
      description:
        "Grant canonical host roots to a caller change instance (orchestrator-only " +
        "mutation; requires human approval). Roots are forwarded in order; an " +
        "initial grant may omit the CAS revision. Returns JSON.",
      args: {
        change: sddIdentifierArg,
        expectedRevision: deps.revisionArg.optional(),
        roots: z.array(z.string().min(1).max(4096)).min(1).max(32),
        changeInstance: z.string().min(1).max(128),
        requestId: sddLowercaseRequestIdArg,
        actor: z.string().min(1).max(128),
        reason: z.string().min(1).max(500),
      },
      execute: async (args, ctx) => {
        await ctx.ask(buildSddAttemptGrantAsk(args));
        const c = await deps.client();
        const payload: Record<string, unknown> = {
          projectDir: deps.projectDirectory(ctx.directory),
          change: args.change,
          roots: args.roots,
          changeInstance: args.changeInstance,
          requestId: args.requestId,
          actor: args.actor,
          reason: args.reason,
        };
        if (args.expectedRevision) payload.expectedRevision = args.expectedRevision;
        const result = await c.request("sddAttemptGrant", ctx.sessionID, payload, ctx.agent);
        return JSON.stringify(result, null, 2);
      },
    }),
    host_sdd_archive_compose: tool({
      description:
        "Compose an SDD archive delta into the canonical spec (orchestrator-only " +
        "mutation; requires human approval). canonical/delta/output are " +
        "project-relative paths. Returns JSON.",
      args: { canonical: sddPathArg, delta: sddPathArg, output: sddPathArg },
      execute: async (args, ctx) => {
        await ctx.ask(buildSddArchiveComposeAsk(args));
        const c = await deps.client();
        const result = await c.request("sddArchiveCompose", ctx.sessionID, {
          projectDir: deps.projectDirectory(ctx.directory),
          canonical: args.canonical,
          delta: args.delta,
          output: args.output,
        }, ctx.agent);
        return JSON.stringify(result, null, 2);
      },
    }),
  };
}
