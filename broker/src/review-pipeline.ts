import { spawnExec, type SpawnFn, type SpawnResult } from "./msb.ts";
import {
  assertPinnedReviewHelper,
  assertReviewRunId,
  readRunArtifact,
  ReviewRunStore,
  resolveReviewHelperInterpreter,
  ReviewHelperMissingError,
  ReviewRunError,
} from "./review-run.ts";
import type { BrokerConfig } from "./config.ts";

export const REVIEW_PIPELINE_MAX_STDIN_BYTES = 256 * 1024;
// These are the ce:review persona names from the Systematic persona catalog, deliberately NOT the native 4R lens names.
export const REVIEW_PIPELINE_REVIEWERS = [
  "correctness",
  "testing",
  "project-standards",
  "maintainability",
  "security",
  "performance",
  "api-contract",
  "data-migrations",
  "reliability",
  "adversarial",
  "cli-readiness",
  "previous-comments",
  "kieran-typescript",
] as const;
export type ReviewPipelinePhase = "screen" | "prepare" | "merge" | "finalize";
export type ReviewPipelineResult =
  | { outcome: "accepted"; artifact: { name: string; bytes: number; sha256: string }; summary: { phase: ReviewPipelinePhase; topLevelKeys: string[] } }
  | { outcome: "structurally_rejected"; code: "review_pipeline_structurally_rejected"; diagnostic: string }
  | { outcome: "validation_unavailable"; code: "review_pipeline_validation_unavailable"; diagnostic: string };

export class ReviewPipelineError extends ReviewRunError {
  constructor(code: string, message: string) { super(code, message); }
}

export interface ReviewPipelinePayload {
  phase: unknown;
  reviewer?: unknown;
  stdin?: unknown;
  inputRef?: unknown;
  runId: unknown;
}

export interface ReviewPipelineStoreContext {
  store: ReviewRunStore;
  sessionID: string;
}

const PHASES: readonly ReviewPipelinePhase[] = ["screen", "prepare", "merge", "finalize"];
const STDERR_MAX_BYTES = 4096;
const spawnWithReplacementEnv: SpawnFn = (argv, opts) =>
  spawnExec(argv, { ...opts, envMode: "replace" });

function diagnostic(result: SpawnResult): string {
  const bytes = result.stderrBytes ?? Buffer.from(result.stderr, "utf8");
  return bytes.subarray(0, STDERR_MAX_BYTES).toString("utf8");
}

export async function runReviewPipeline(
  payload: ReviewPipelinePayload,
  config: Pick<BrokerConfig, "reviewHelperPath" | "reviewHelperSha256" | "reviewHelperInterpreter">,
  spawn: SpawnFn = spawnWithReplacementEnv,
  storeContext?: ReviewPipelineStoreContext,
): Promise<ReviewPipelineResult> {
  if (typeof payload.phase !== "string" || !PHASES.includes(payload.phase as ReviewPipelinePhase)) {
    throw new ReviewPipelineError("review_pipeline_phase_invalid", "phase must be screen, prepare, merge, or finalize");
  }
  const phase = payload.phase as ReviewPipelinePhase;
  if (phase === "screen") {
    if (typeof payload.reviewer !== "string" || !(REVIEW_PIPELINE_REVIEWERS as readonly string[]).includes(payload.reviewer)) {
      throw new ReviewPipelineError("review_pipeline_reviewer_invalid", "screen requires an enumerated reviewer persona");
    }
  } else if (payload.reviewer !== undefined) {
    throw new ReviewPipelineError("review_pipeline_reviewer_forbidden", "reviewer is only valid for screen");
  }
  assertReviewRunId(payload.runId);
  const hasStdin = payload.stdin !== undefined;
  const hasInputRef = payload.inputRef !== undefined;
  if (!hasStdin && !hasInputRef) {
    throw new ReviewPipelineError("review_pipeline_stdin_source_missing", "exactly one of stdin or inputRef must be supplied; neither was provided");
  }
  if (hasStdin && hasInputRef) {
    throw new ReviewPipelineError("review_pipeline_stdin_source_conflict", "exactly one of stdin or inputRef must be supplied; both were provided");
  }
  let input: Buffer;
  if (hasInputRef) {
    if (typeof payload.inputRef !== "string" || !storeContext) {
      throw new ReviewPipelineError("review_pipeline_input_ref_invalid", "inputRef must name a published artifact in this review run");
    }
    const phaseIndex = PHASES.indexOf(phase);
    const reviewerSuffixes = REVIEW_PIPELINE_REVIEWERS
      .map((reviewer) => reviewer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    const phaseMatch = new RegExp(`^phase-(screen|prepare|merge|finalize)(?:-(${reviewerSuffixes}))?\\.json$`).exec(payload.inputRef);
    if (!phaseMatch) {
      throw new ReviewPipelineError("review_pipeline_input_ref_unknown", "inputRef does not name a recognized phase artifact");
    }
    const sourcePhase = PHASES.indexOf(phaseMatch[1] as ReviewPipelinePhase);
    if (sourcePhase >= phaseIndex) {
      throw new ReviewPipelineError("review_pipeline_input_ref_not_prior", "inputRef must name an artifact from a strictly prior phase");
    }
    input = readRunArtifact({ runDir: storeContext.store.runDir(storeContext.sessionID, payload.runId as string), name: payload.inputRef, maxFileBytes: storeContext.store.caps.maxFileBytes }).data;
  } else {
    if (typeof payload.stdin !== "string" &&
      (!Array.isArray(payload.stdin) || payload.stdin.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))) {
      throw new ReviewPipelineError("review_pipeline_stdin_invalid", "stdin must be a string or an array of bytes");
    }
    input = typeof payload.stdin === "string" ? Buffer.from(payload.stdin, "utf8") : Buffer.from(payload.stdin as number[]);
  }
  if (hasStdin && input.byteLength > REVIEW_PIPELINE_MAX_STDIN_BYTES) {
    throw new ReviewPipelineError(
      "review_pipeline_stdin_too_large",
      `review pipeline inline stdin exceeds ${REVIEW_PIPELINE_MAX_STDIN_BYTES} bytes (observed ${input.byteLength} bytes)`,
    );
  }
  let helper: ReturnType<typeof assertPinnedReviewHelper>;
  try {
    helper = assertPinnedReviewHelper(config);
  } catch (cause) {
    if (cause instanceof ReviewHelperMissingError) {
      return { outcome: "validation_unavailable", code: "review_pipeline_validation_unavailable", diagnostic: cause.message.slice(0, STDERR_MAX_BYTES) };
    }
    throw cause;
  }
  // Heredoc delimiters exist to protect shell interpolation; argv spawning has no shell.
  const interpreter = resolveReviewHelperInterpreter(config);
  const phaseArgs = phase === "screen"
    ? ["screen", "--reviewer", payload.reviewer as string, "--harness", "opencode"]
    : [phase];
  let result: SpawnResult;
  const maxOutputBytes = storeContext
    ? storeContext.store.caps.maxFileBytes + 1
    : 256 * 1024;
  try {
    result = await spawn([interpreter, helper.path, ...phaseArgs], {
      stdin: input,
      timeoutMs: 30_000,
      maxOutputBytes,
      env: { PATH: process.env.PATH ?? "" },
    });
  } catch (cause) {
    return { outcome: "validation_unavailable", code: "review_pipeline_validation_unavailable", diagnostic: cause instanceof Error ? cause.message.slice(0, STDERR_MAX_BYTES) : "helper could not start" };
  }
  if (result.status === 0 && !result.timedOut) {
    if (!storeContext) throw new ReviewPipelineError("review_pipeline_store_unavailable", "review run store is required to publish phase output");
    const outputBytes = result.stdoutBytes ?? Buffer.from(result.stdout, "utf8");
    const cap = storeContext.store.caps.maxFileBytes;
    if (outputBytes.byteLength > cap) {
      throw new ReviewPipelineError("review_pipeline_output_too_large", `review pipeline output exceeds per-file cap ${cap} bytes (observed ${outputBytes.byteLength} bytes)`);
    }
    let output: unknown;
    try {
      output = JSON.parse(outputBytes.toString("utf8")) as unknown;
    } catch {
      throw new ReviewPipelineError("review_pipeline_output_invalid", "helper returned invalid JSON");
    }
    const name = phase === "screen" ? `phase-screen-${payload.reviewer as string}.json` : `phase-${phase}.json`;
    const artifact = storeContext.store.addArtifact(storeContext.sessionID, payload.runId as string, name, outputBytes);
    if (phase === "finalize") {
      storeContext.store.recordFinalizeProvenance(storeContext.sessionID, payload.runId as string, { phase, outcome: "accepted", artifact });
    }
    const topLevelKeys = output !== null && typeof output === "object" && !Array.isArray(output)
      ? Object.keys(output).slice(0, 32).map((key) => key.slice(0, 128))
      : [];
    return { outcome: "accepted", artifact: { name: artifact.name, bytes: artifact.bytes, sha256: artifact.sha256 }, summary: { phase, topLevelKeys } };
  }
  const stderrDiagnostic = diagnostic(result);
  const internalFailure = result.status === 1 && stderrDiagnostic.startsWith("ce-review-validator: internal error in ");
  if (phase === "finalize") {
    storeContext?.store.recordFinalizeProvenance(storeContext.sessionID, payload.runId as string, {
      phase,
      outcome: result.status === 1 && !internalFailure ? "structurally_rejected" : "validation_unavailable",
    });
  }
  if (result.status === 1 && !internalFailure) return { outcome: "structurally_rejected", code: "review_pipeline_structurally_rejected", diagnostic: stderrDiagnostic };
  return { outcome: "validation_unavailable", code: "review_pipeline_validation_unavailable", diagnostic: stderrDiagnostic };
}
