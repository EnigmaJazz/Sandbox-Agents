/**
 * Host-neutral runtime shared by the sandbox tool table (P0, docs/upgrades/opencode-v2.md).
 *
 * Nothing here depends on an OpenCode plugin API: broker access, argument schemas, result
 * formatting and the orchestrator read-only guard. The V1 adapter (sandbox-tools.ts) and a later
 * V2 adapter both consume these through the tool table.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { z } from "zod";
import {
  createBrokerClient,
  brokerSocketPath,
  type BrokerClient,
} from "./broker-client.ts";

export const READ_ONLY_AGENTS: readonly string[] = [
  "gentle-orchestrator",
  "pm-odd",
  "pm-systematic",
  "pm-sdd",
  "pm-odd-astra",
  "pm-systematic-astra",
];

export function assertNotOrchestrator(agent: string | undefined, toolName: string): void {
  if (agent && READ_ONLY_AGENTS.includes(agent)) {
    throw new Error(`orchestrator agent "${agent}" is not allowed to use sandbox operation "${toolName}" (orchestrator-readonly)`);
  }
}

let clientPromise: Promise<BrokerClient> | null = null;

export function client(): Promise<BrokerClient> {
  if (!clientPromise) {
    clientPromise = createBrokerClient({ socketPath: brokerSocketPath() }).catch((err) => {
      clientPromise = null; // allow retry on the next call
      throw err;
    });
  }
  return clientPromise;
}

/** Map an opencode session to a worker; reuses an existing one (§13, §28). */
export async function ensureWorker(sessionID: string, directory: string | undefined): Promise<unknown> {
  const c = await client();
  return await c.request("ensureWorker", sessionID, { projectDir: directory ?? process.cwd() });
}

export function notActiveError(): Error {
  return new Error(
    "This session has no active sandbox worker yet. The FIRST sandbox mutation (sandbox_write / sandbox_edit / sandbox_apply_patch / sandbox_bash) opens the worker automatically - no separate activation step. Until then use the host read/grep tools. All sandbox_* file paths are RELATIVE to the project root (e.g. broker/src/service.ts) - never absolute.",
  );
}

/**
 * Minimal, safe command tokenizer: splits on whitespace and honors
 * single/double quotes. NO shell semantics — no expansion, globbing,
 * redirection, pipes or environment interpolation. The resulting argv is
 * validated broker-side (shell metacharacters rejected).
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote) {
    throw new Error("unterminated quote in command");
  }
  if (current.length > 0) tokens.push(current);
  if (tokens.length === 0) {
    throw new Error("empty command");
  }
  return tokens;
}

export const pathArg = z.string().min(1).max(4096);
export const sessionIdArg = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const contentArg = z.string().max(1024 * 1024);
export const untrackedInventoryArg = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const reviewAgentArg = z.string().regex(/^[a-z0-9_-]{1,64}$/);

export function currentProjectDirectory(directory: string | undefined): string {
  if (!directory) throw new Error("host-side SDD runtime requires the current project directory");
  return directory;
}

/**
 * Format a broker response as an opencode ToolResult string.
 *
 * opencode 1.18 tool.execute MUST return a string (or {output: string});
 * returning the raw broker object crashed the plugin runtime with
 * "undefined is not an object (evaluating 'c.split')" (Gate 5 live finding).
 */
export function formatResult(operation: string, result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  switch (operation) {
    case "readFile":
      return String(r.content ?? "");
    case "exec": {
      const stdout = String(r.stdout ?? "");
      const stderr = String(r.stderr ?? "");
      const status = Number(r.status ?? 0);
      const body = stderr.length > 0 ? `${stdout}\n${stderr}`.trim() : stdout;
      return status === 0 ? body : `exit ${status}\n${body}`.trim();
    }
    case "listDir":
      return String(r.listing ?? "");
    case "grep": {
      const m = r.matches;
      return typeof m === "string" ? m : JSON.stringify(m ?? [], null, 2);
    }
    case "diff": {
      const diff = r.diff;
      const stat = r.stat;
      if (typeof diff === "string" && diff.length > 0) return diff;
      if (typeof stat === "string" && stat.length > 0) return stat;
      return JSON.stringify(r, null, 2);
    }
    case "writeFile":
      return `wrote ${String(r.path ?? "?")}`;
    case "applyPatch":
      return `patch applied${r.changedLines !== undefined ? ` (${String(r.changedLines)} lines changed)` : ""}`;
    case "ensureWorker":
      return `worker ${String(r.worker ?? "?")} ${r.reused ? "reused" : "created"} (state ${String(r.state ?? "?")})`;
    case "workerStatus":
      return `state: ${String(r.state ?? "?")}`;
    case "prepareResult":
      return `result ready: ${String(r.resultRef ?? "?")}`;
    case "applyResult":
      return `applied to host: ${String(r.resultRef ?? "?")}`;
    case "discardResult":
      return `discarded; worker ${String(r.state ?? "?")}`;
    case "copyOutInfo":
      return JSON.stringify(r, null, 2);
    case "copyOut":
      return `copied to host: ${String(r.target ?? "?")}`;
    case "copyInInfo":
      return JSON.stringify(r, null, 2);
    case "copyIn":
      return `copied to worker: ${String(r.path ?? "?")}`;
    default:
      return JSON.stringify(r, null, 2);
  }
}

export const reviewTokenArg = z.string().min(1).max(4096);
export const reviewShaArg = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const reviewProjectionArg = z.enum(["workspace", "staged"]);
export const reviewFocusArg = z.enum(["risk", "resilience", "readability", "reliability"]);
export const reviewConsentArg = z.enum(["relay", "granted", "declined"]);
export const reviewLocaleArg = z.enum(["en", "es"]);
export const reviewGateArg = z.enum(["post-apply", "pre-commit", "pre-push", "pre-pr", "release"]);
export const reviewDispositionArg = z.enum(["scope_changed", "invalidated", "escalated"]);
export const reviewOrderArg = z.number().int().min(0).max(32);
export const reviewReasonArg = z.string().min(1).max(4096);
export const reviewDetailArg = z.string().min(1).max(16384);
export const reviewPipelineEnvelopeArg = z.unknown().refine((value) => {
  try { const text = JSON.stringify(value); return text !== undefined && Buffer.byteLength(text, "utf8") <= 32 * 1024; }
  catch { return false; }
}).optional();
export const reviewActorArg = z.string().min(1).max(128);
export const reviewBaseRefArg = z.string().min(1).max(1024);
export const reviewCorrectionLinesArg = z.number().int().positive();

/** Is `child` equal to or beneath `parent`? Mirrors broker validation.isWithin. */
export function isWithinPath(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Best-effort host-side size/digest preview for a review-capture input file. */
export function describeReviewInput(
  projectDir: string,
  input: string | undefined,
): { inputBytes?: number; inputDigest?: string } {
  if (input === undefined || input === "-") return {};
  try {
    // Canonicalize before reading: the project-relative resolver is lexical
    // only, so a symlink inside the project could still resolve outside it.
    const root = realpathSync(projectDir);
    const candidate = resolve(root, input);
    if (!isWithinPath(root, candidate)) return {};
    const real = realpathSync(candidate);
    if (!isWithinPath(root, real)) return {};
    const stat = statSync(real);
    if (!stat.isFile()) return {};
    const digest = createHash("sha256")
      .update(readFileSync(real))
      .digest("hex")
      .slice(0, 16);
    return { inputBytes: stat.size, inputDigest: digest };
  } catch {
    return {};
  }
}

/** Best-effort size/digest preview for an inline review-capture JSON body. */
export function describeInlineReviewInput(
  inputJson: string | undefined,
): { inputJsonBytes?: number; inputJsonDigest?: string } {
  if (inputJson === undefined) return {};
  return {
    inputJsonBytes: Buffer.byteLength(inputJson, "utf8"),
    inputJsonDigest: createHash("sha256").update(inputJson).digest("hex").slice(0, 16),
  };
}
