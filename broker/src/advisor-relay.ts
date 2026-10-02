/**
 * Stored-response relay (odd/tasks/external-advisors.md A4;
 * docs/advisor/interface-contract.md §3–§4).
 *
 * gentle-ai trusts submitted reviewer content, so on an external-lens lineage
 * whoever can call capture-result with free input can approve the review.
 * This module closes that hole:
 *
 * - On an external-lens lineage, free-form `input`/`inputJson` and any
 *   runtime `agent` are refused (`guardExternalLensCapture`).
 * - `inputFromAdvisorResponse` relays ONLY a stored, submitted review-lens
 *   response. The caller supplies nothing else: the broker reads a fresh
 *   collect input from gentle-ai, requires its target, order and subject hash
 *   to match the response's, takes the current revision and repository
 *   context from it, runs `--preflight`, then the real capture, with the
 *   stored result as the staged input.
 * - Each (lineage, lens) is relayed at most once: an exclusive marker is the
 *   lock, released when gentle-ai refuses so a corrected retry stays possible.
 */
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isExternalLensLineage } from "./advisor-lineages.ts";
import { readRelayableLensResponse } from "./advisor-records.ts";
import { PolicyError } from "./policy.ts";
import type { SddRuntimeExecutor, SddRuntimeResult } from "./sdd-runtime.ts";
import type { OpContext } from "./service.ts";
import { resolveProjectID } from "./validation.ts";

type RelayContext = OpContext & {
  sddRuntime: Pick<SddRuntimeExecutor, "reviewStatus" | "reviewCaptureResult">;
};

/** Capture fields the broker supplies itself when relaying a stored response. */
const BROKER_SUPPLIED = [
  "agent",
  "input",
  "inputJson",
  "lens",
  "order",
  "target",
  "lineage",
  "expectedRevision",
  "repositoryContext",
  "subjectHash",
  "materialize",
  "preflight",
] as const;

/** Refuse free-form capture input or a runtime agent on an external-lens lineage. */
export function guardExternalLensCapture(ctx: OpContext, projectDir: string, payload: Record<string, unknown>): void {
  if (typeof payload.lineage !== "string") return;
  let projectId: string;
  try {
    projectId = resolveProjectID(projectDir, ctx.config.projects);
  } catch {
    return; // the runtime refuses an unresolvable project on its own
  }
  if (!/^review-[A-Za-z0-9]{1,64}$/.test(payload.lineage)) return;
  if (!isExternalLensLineage(ctx, projectId, payload.lineage)) return;
  if (payload.input !== undefined || payload.inputJson !== undefined || payload.agent !== undefined) {
    throw new PolicyError(
      "an external-lens lineage accepts reviewer results only through inputFromAdvisorResponse (no free-form input, no agent)",
    );
  }
}

function relayMarkersDir(ctx: OpContext, projectId: string): string {
  const dir = join(ctx.config.stateDir, "advisor", projectId, "relayed");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function succeeded(result: SddRuntimeResult): boolean {
  return result.status === 0;
}

function cause(result: SddRuntimeResult): string {
  const json = result.json as { cause?: string; message?: string } | null;
  return (json?.cause ?? json?.message ?? result.stderr ?? "").slice(0, 400);
}

export async function relayAdvisorResponse(
  ctx: RelayContext,
  projectDir: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  for (const key of BROKER_SUPPLIED) {
    if (payload[key] !== undefined) {
      throw new PolicyError(`inputFromAdvisorResponse is exclusive: the broker supplies '${key}' itself`);
    }
  }
  const projectId = resolveProjectID(projectDir, ctx.config.projects);
  const stored = readRelayableLensResponse(ctx, projectId, payload.inputFromAdvisorResponse);
  const { review } = stored;
  if (!isExternalLensLineage(ctx, projectId, review.lineage)) {
    throw new PolicyError(`lineage ${review.lineage} is not an external-lens lineage`);
  }

  // Fresh provider values: revision and context rotate on state transitions.
  const status = await ctx.sddRuntime.reviewStatus({ projectDir, lineage: review.lineage });
  if (status.status !== 0 || !status.json || typeof status.json !== "object") {
    throw new PolicyError(`gentle-ai review status failed (exit ${String(status.status)}): ${status.stderr.slice(0, 300)}`);
  }
  const transition = (status.json as { next_transition?: { kind?: string; collect?: { inputs?: unknown[] } } }).next_transition;
  const inputs = transition?.kind === "collect" ? (transition.collect?.inputs ?? []) : [];
  const fresh = inputs
    .map((input) => (input as { arguments?: Array<{ name: string; value: string }> }).arguments ?? [])
    .map((list) => Object.fromEntries(list.map((a) => [a.name, a.value])) as Record<string, string>)
    .find((a) => a.lens === review.lens);
  if (!fresh) throw new PolicyError(`lineage ${review.lineage} is not collecting a result for ${review.lens}`);
  if (fresh.target !== review.target || Number(fresh.order) !== review.order || fresh["subject-hash"] !== review.subjectHash) {
    throw new PolicyError("the advisory response is stale: the candidate or lens slot changed since it was requested");
  }

  // At most one relay per (lineage, lens); the exclusive marker is the lock.
  const marker = join(relayMarkersDir(ctx, projectId), `${review.lineage}.${review.lens}`);
  try {
    writeFileSync(marker, `${stored.id}\n`, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new PolicyError(`${review.lens} of ${review.lineage} was already relayed`);
    }
    throw err;
  }

  const capture = {
    projectDir,
    lineage: review.lineage,
    lens: review.lens,
    order: review.order,
    target: review.target,
    subjectHash: review.subjectHash,
    expectedRevision: fresh["expected-revision"],
    repositoryContext: fresh["repository-context"],
    inputJson: JSON.stringify(stored.reviewerResult),
  };
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(marker);
    } catch {
      /* already gone */
    }
  };
  try {
    const preflight = await ctx.sddRuntime.reviewCaptureResult({ ...capture, preflight: true });
    if (!succeeded(preflight)) {
      release();
      throw new PolicyError(`gentle-ai preflight refused the advisory response: ${cause(preflight)}`);
    }
    const captured = await ctx.sddRuntime.reviewCaptureResult(capture);
    if (!succeeded(captured)) {
      release();
      throw new PolicyError(`gentle-ai capture refused the advisory response: ${cause(captured)}`);
    }
    return { ...(captured as object), relayedAdvisoryResponse: stored.id };
  } catch (err) {
    release();
    throw err;
  }
}
