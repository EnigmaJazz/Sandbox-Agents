import { spawnExec, type SpawnFn, type SpawnResult } from "./msb.ts";
import {
  assertPinnedReviewHelper,
  assertReviewRunId,
  resolveReviewHelperInterpreter,
  ReviewHelperMissingError,
  ReviewRunError,
} from "./review-run.ts";
import type { BrokerConfig } from "./config.ts";

export const REVIEW_PIPELINE_MAX_STDIN_BYTES = 256 * 1024;
export const REVIEW_PIPELINE_REVIEWERS = [
  "review-risk",
  "review-resilience",
  "review-readability",
  "review-reliability",
] as const;
export type ReviewPipelinePhase = "screen" | "prepare" | "merge" | "finalize";
export type ReviewPipelineResult =
  | { outcome: "accepted"; output: unknown }
  | { outcome: "structurally_rejected"; code: "review_pipeline_structurally_rejected"; diagnostic: string }
  | { outcome: "validation_unavailable"; code: "review_pipeline_validation_unavailable"; diagnostic: string };

export class ReviewPipelineError extends ReviewRunError {
  constructor(code: string, message: string) { super(code, message); }
}

export interface ReviewPipelinePayload {
  phase: unknown;
  reviewer?: unknown;
  stdin: unknown;
  runId: unknown;
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
  if (typeof payload.stdin !== "string" &&
    (!Array.isArray(payload.stdin) || payload.stdin.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))) {
    throw new ReviewPipelineError("review_pipeline_stdin_invalid", "stdin must be a string or an array of bytes");
  }
  const input = typeof payload.stdin === "string"
    ? Buffer.from(payload.stdin, "utf8")
    : Buffer.from(payload.stdin as number[]);
  if (input.byteLength > REVIEW_PIPELINE_MAX_STDIN_BYTES) {
    throw new ReviewPipelineError(
      "review_pipeline_stdin_too_large",
      `review pipeline stdin exceeds ${REVIEW_PIPELINE_MAX_STDIN_BYTES} bytes (observed ${input.byteLength} bytes)`,
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
  try {
    result = await spawn([interpreter, helper.path, ...phaseArgs], {
      stdin: input,
      timeoutMs: 30_000,
      maxOutputBytes: 256 * 1024,
      env: { PATH: process.env.PATH ?? "" },
    });
  } catch (cause) {
    return { outcome: "validation_unavailable", code: "review_pipeline_validation_unavailable", diagnostic: cause instanceof Error ? cause.message.slice(0, STDERR_MAX_BYTES) : "helper could not start" };
  }
  if (result.status === 0 && !result.timedOut && !result.outputTruncated) {
    try {
      return { outcome: "accepted", output: JSON.parse(result.stdout) as unknown };
    } catch {
      throw new ReviewPipelineError("review_pipeline_output_invalid", "helper returned invalid JSON");
    }
  }
  if (result.status === 1) return { outcome: "structurally_rejected", code: "review_pipeline_structurally_rejected", diagnostic: diagnostic(result) };
  return { outcome: "validation_unavailable", code: "review_pipeline_validation_unavailable", diagnostic: diagnostic(result) };
}
