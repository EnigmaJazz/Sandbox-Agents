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
export const REVIEW_PIPELINE_MAX_INPUT_REFS = 16;
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
  inputRefs?: unknown;
  runId: unknown;
}

export interface ReviewPipelineStoreContext {
  store: ReviewRunStore;
  sessionID: string;
}

const PHASES: readonly ReviewPipelinePhase[] = ["screen", "prepare", "merge", "finalize"];
const STDERR_MAX_BYTES = 4096;
const REVIEWER_SUFFIXES = REVIEW_PIPELINE_REVIEWERS
  .map((reviewer) => reviewer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

function matchPhaseArtifact(ref: string): RegExpExecArray | null {
  return new RegExp(`^phase-(screen|prepare|merge|finalize)(?:-(${REVIEWER_SUFFIXES}))?\\.json$`).exec(ref);
}
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
  const hasInputRefs = payload.inputRefs !== undefined;
  const sourceCount = Number(hasStdin) + Number(hasInputRef) + Number(hasInputRefs);
  if (sourceCount === 0) {
    throw new ReviewPipelineError("review_pipeline_stdin_source_missing", "exactly one of stdin, inputRef, or inputRefs must be supplied; none was provided");
  }
  if (sourceCount > 1) {
    throw new ReviewPipelineError("review_pipeline_stdin_source_conflict", "exactly one of stdin, inputRef, or inputRefs must be supplied; multiple sources were provided");
  }
  let input: Buffer;
  if (hasInputRefs) {
    if (phase !== "prepare") {
      throw new ReviewPipelineError("review_pipeline_input_refs_phase_forbidden", `inputRefs is only valid for prepare (received ${phase})`);
    }
    if (!Array.isArray(payload.inputRefs) || !storeContext) {
      throw new ReviewPipelineError("review_pipeline_input_refs_invalid", "inputRefs must be an array of published screen artifacts in this review run");
    }
    if (payload.inputRefs.length > REVIEW_PIPELINE_MAX_INPUT_REFS) {
      throw new ReviewPipelineError("review_pipeline_input_refs_too_many", `inputRefs exceeds limit ${REVIEW_PIPELINE_MAX_INPUT_REFS} (observed ${payload.inputRefs.length})`);
    }
    if (payload.inputRefs.length === 0) {
      throw new ReviewPipelineError("review_pipeline_input_refs_empty", "inputRefs must contain at least one screen artifact");
    }
    const seenRefs = new Set<string>();
    const parts: Buffer[] = [];
    for (const ref of payload.inputRefs) {
      if (typeof ref !== "string" || ref.length > 255) {
        throw new ReviewPipelineError("review_pipeline_input_refs_invalid", "each inputRefs entry must be a bounded artifact name");
      }
      const phaseMatch = matchPhaseArtifact(ref);
      if (!phaseMatch || phaseMatch[1] !== "screen" || !phaseMatch[2]) {
        throw new ReviewPipelineError("review_pipeline_input_ref_not_screen", `inputRefs artifact is not a screen artifact: ${ref}`);
      }
      if (seenRefs.has(ref)) {
        throw new ReviewPipelineError("review_pipeline_input_ref_duplicate", `inputRefs contains a duplicate screen artifact: ${ref}`);
      }
      seenRefs.add(ref);
      const bytes = readRunArtifact({ runDir: storeContext.store.runDir(storeContext.sessionID, payload.runId as string), name: ref, maxFileBytes: storeContext.store.caps.maxFileBytes }).data;
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8")) as unknown;
      } catch {
        throw new ReviewPipelineError("review_pipeline_input_ref_unparseable", `screen artifact is not parseable JSON: ${ref}`);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ReviewPipelineError("review_pipeline_input_ref_not_object", `screen artifact must contain a JSON object: ${ref}`);
      }
      parts.push(bytes);
    }
    input = Buffer.concat([Buffer.from('{"screen_results":['), ...parts.flatMap((part, index) => index ? [Buffer.from(","), part] : [part]), Buffer.from("]}")]);
  } else if (hasInputRef) {
    if (typeof payload.inputRef !== "string" || !storeContext) {
      throw new ReviewPipelineError("review_pipeline_input_ref_invalid", "inputRef must name a published artifact in this review run");
    }
    const phaseIndex = PHASES.indexOf(phase);
    const phaseMatch = matchPhaseArtifact(payload.inputRef);
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
  if ((hasStdin || hasInputRefs) && input.byteLength > REVIEW_PIPELINE_MAX_STDIN_BYTES) {
    throw new ReviewPipelineError(
      hasInputRefs ? "review_pipeline_input_refs_too_large" : "review_pipeline_stdin_too_large",
      `review pipeline stdin exceeds cap ${REVIEW_PIPELINE_MAX_STDIN_BYTES} bytes (observed ${input.byteLength} bytes)`,
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
