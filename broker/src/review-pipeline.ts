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
export const REVIEW_PIPELINE_MAX_ENVELOPE_BYTES = 32 * 1024;
export const REVIEW_PIPELINE_MAX_CALLER_BYTES = 64 * 1024;
const REVIEW_PIPELINE_MAX_VALIDATOR_REQUESTS = 32;
const REVIEW_PIPELINE_MAX_VALIDATOR_FINDING_ID_LENGTH = 128;
const REVIEW_PIPELINE_MAX_VALIDATOR_FILE_LENGTH = 512;
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
export type ReviewPipelineInputSource = "stdin" | "inputRef" | "inputRefs";
export type ReviewPipelineResult =
  | { outcome: "accepted"; artifact: { name: string; bytes: number; sha256: string }; summary: { phase: ReviewPipelinePhase; inputSource: ReviewPipelineInputSource; topLevelKeys: string[]; validator_requests?: Array<{ finding_id: string; file?: string; line?: number }>; validator_request_count?: number; validator_requests_truncated?: boolean; validator_requests_present?: boolean } }
  | { outcome: "invalid_output"; code: "review_pipeline_validator_requests_invalid"; diagnostic: string; artifact: { name: string; bytes: number; sha256: string }; inputSource: ReviewPipelineInputSource }
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
  adjudication?: unknown;
  preparedRef?: unknown;
  mergeRef?: unknown;
  dispatch_records?: unknown;
  validator_lifecycle_results?: unknown;
  plan_assessment?: unknown;
  parent_run_metadata?: unknown;
  prepared?: unknown;
  merge?: unknown;
  screen_results?: unknown;
  selected_dispatches?: unknown;
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

function phaseObject(context: ReviewPipelineStoreContext, runId: string, ref: string): Record<string, unknown> {
  const bytes = readRunArtifact({ runDir: context.store.runDir(context.sessionID, runId), name: ref, maxFileBytes: context.store.caps.maxFileBytes }).data;
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new ReviewPipelineError("review_pipeline_input_ref_unparseable", `phase artifact is not parseable JSON: ${ref}`); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ReviewPipelineError("review_pipeline_input_ref_not_object", `phase artifact must contain a JSON object: ${ref}`);
  return value as Record<string, unknown>;
}

function wrapScreenResult(context: ReviewPipelineStoreContext, runId: string, ref: string): { reviewer: string; result: Record<string, unknown> } {
  const match = matchPhaseArtifact(ref);
  if (!match || match[1] !== "screen" || !match[2]) {
    throw new ReviewPipelineError("review_pipeline_input_ref_not_screen", `inputRefs artifact is not a screen artifact: ${ref}`);
  }
  const bytes = readRunArtifact({ runDir: context.store.runDir(context.sessionID, runId), name: ref, maxFileBytes: context.store.caps.maxFileBytes }).data;
  let result: unknown;
  try {
    result = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new ReviewPipelineError("review_pipeline_input_ref_unparseable", `screen artifact is not parseable JSON: ${ref}`);
  }
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new ReviewPipelineError("review_pipeline_input_ref_not_object", `screen artifact must contain a JSON object: ${ref}`);
  }
  return { reviewer: match[2], result: result as Record<string, unknown> };
}

function callerBytes(entries: Array<[string, unknown]>): Buffer[] {
  let total = 0;
  return entries.map(([field, value]) => {
    let text: string | undefined;
    try { text = JSON.stringify(value); } catch { /* rejected below */ }
    if (text === undefined || value === null || typeof value !== "object") throw new ReviewPipelineError(`review_pipeline_${field}_invalid`, `${field} must be a JSON object or array`);
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength > REVIEW_PIPELINE_MAX_ENVELOPE_BYTES) throw new ReviewPipelineError(`review_pipeline_${field}_too_large`, `${field} exceeds envelope cap ${REVIEW_PIPELINE_MAX_ENVELOPE_BYTES} bytes (observed ${bytes.byteLength} bytes)`);
    total += bytes.byteLength;
    if (total > REVIEW_PIPELINE_MAX_CALLER_BYTES) throw new ReviewPipelineError("review_pipeline_caller_envelopes_too_large", `caller-supplied envelopes exceed total cap ${REVIEW_PIPELINE_MAX_CALLER_BYTES} bytes (observed ${total} bytes)`);
    return bytes;
  });
}

function assertRecordedComposedSize(record: ReturnType<ReviewRunStore["readRecord"]>, refs: readonly string[]): void {
  const names = new Set(refs);
  const total = record.artifacts.reduce((sum, artifact) => names.has(artifact.name) ? sum + artifact.bytes : sum, 0);
  if (total > REVIEW_PIPELINE_MAX_STDIN_BYTES) {
    throw new ReviewPipelineError(
      "review_pipeline_composed_input_too_large",
      `review pipeline stdin exceeds cap ${REVIEW_PIPELINE_MAX_STDIN_BYTES} bytes (observed ${total} bytes)`,
    );
  }
}

function composeMerge(payload: ReviewPipelinePayload, context?: ReviewPipelineStoreContext): Buffer {
  for (const field of ["dispatch_records", "validator_lifecycle_results", "plan_assessment", "parent_run_metadata"] as const) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) throw new ReviewPipelineError(`review_pipeline_${field}_phase_forbidden`, `${field} is only valid for finalize`);
  }
  if (payload.stdin !== undefined || payload.inputRefs !== undefined || payload.preparedRef !== undefined || payload.mergeRef !== undefined) throw new ReviewPipelineError("review_pipeline_stdin_source_conflict", "merge accepts only inputRef naming its prepared artifact");
  if (typeof payload.inputRef !== "string" || !context) throw new ReviewPipelineError("review_pipeline_input_ref_invalid", "merge requires inputRef naming a prepared artifact in this review run");
  const match = matchPhaseArtifact(payload.inputRef);
  if (!match) throw new ReviewPipelineError("review_pipeline_input_ref_unknown", "merge inputRef does not name a recognized phase artifact");
  if (match[1] !== "prepare" || match[2]) throw new ReviewPipelineError("review_pipeline_merge_ref_phase_invalid", `merge inputRef must name phase-prepare.json (received ${payload.inputRef})`);
  if (payload.adjudication === undefined) throw new ReviewPipelineError("review_pipeline_adjudication_missing", "merge requires adjudication");
  const [decisionBytes] = callerBytes([["adjudication", payload.adjudication]]);
  const record = context.store.readRecord(context.sessionID, payload.runId as string);
  assertRecordedComposedSize(record, [payload.inputRef]);
  return Buffer.from(JSON.stringify({ prepared: phaseObject(context, payload.runId as string, payload.inputRef), adjudication: JSON.parse(decisionBytes!.toString("utf8")) }), "utf8");
}

function composeFinalize(payload: ReviewPipelinePayload, context?: ReviewPipelineStoreContext): Buffer {
  if (payload.stdin !== undefined || payload.inputRef !== undefined || payload.inputRefs !== undefined) throw new ReviewPipelineError("review_pipeline_stdin_source_conflict", "finalize accepts only preparedRef and mergeRef artifact references");
  if (payload.adjudication !== undefined) throw new ReviewPipelineError("review_pipeline_adjudication_forbidden", "adjudication is only valid for merge");
  if (!context || typeof payload.preparedRef !== "string" || typeof payload.mergeRef !== "string") throw new ReviewPipelineError("review_pipeline_finalize_refs_missing", "finalize requires preparedRef and mergeRef from this review run");
  if (payload.preparedRef === payload.mergeRef) throw new ReviewPipelineError("review_pipeline_input_ref_duplicate", "finalize preparedRef and mergeRef must be distinct");
  const preparedMatch = matchPhaseArtifact(payload.preparedRef);
  if (!preparedMatch || preparedMatch[1] !== "prepare" || preparedMatch[2]) throw new ReviewPipelineError("review_pipeline_finalize_prepared_ref_phase_invalid", `preparedRef must name phase-prepare.json (received ${payload.preparedRef})`);
  const mergeMatch = matchPhaseArtifact(payload.mergeRef);
  if (!mergeMatch || mergeMatch[1] !== "merge" || mergeMatch[2]) throw new ReviewPipelineError("review_pipeline_finalize_merge_ref_phase_invalid", `mergeRef must name phase-merge.json (received ${payload.mergeRef})`);
  const fields = ["dispatch_records", "validator_lifecycle_results", "plan_assessment", "parent_run_metadata"] as const;
  const encoded = callerBytes(fields.map((field) => [field, payload[field]]));
  const record = context.store.readRecord(context.sessionID, payload.runId as string);
  const screens = [...new Set(record.artifacts.map(({ name }) => name).filter((name) => { const m = matchPhaseArtifact(name); return m?.[1] === "screen" && m[2] !== undefined; }))];
  if (screens.length === 0) throw new ReviewPipelineError("review_pipeline_finalize_screen_results_missing", "finalize requires at least one screened artifact in this review run");
  if (new Set([payload.preparedRef, payload.mergeRef, ...screens]).size !== screens.length + 2) throw new ReviewPipelineError("review_pipeline_input_ref_duplicate", "finalize phase references must be unique");
  assertRecordedComposedSize(record, [payload.preparedRef, payload.mergeRef, ...screens]);
  const parentRunMetadataIndex = fields.indexOf("parent_run_metadata");
  const parentRunMetadata = JSON.parse(encoded[parentRunMetadataIndex]!.toString("utf8")) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(parentRunMetadata, "head_sha") && parentRunMetadata.head_sha !== record.headObjectId) {
    throw new ReviewPipelineError("review_pipeline_parent_head_sha_mismatch", "parent_run_metadata.head_sha does not match the resolved review run head object id");
  }
  const composed = {
    merge: phaseObject(context, payload.runId as string, payload.mergeRef),
    prepared: phaseObject(context, payload.runId as string, payload.preparedRef),
    screen_results: screens.map((ref) => wrapScreenResult(context, payload.runId as string, ref)),
    ...Object.fromEntries(fields.map((field, index) => [field, field === "parent_run_metadata" ? { ...parentRunMetadata, head_sha: record.headObjectId } : JSON.parse(encoded[index]!.toString("utf8"))])),
  };
  return Buffer.from(JSON.stringify(composed), "utf8");
}

function createSummary(
  phase: ReviewPipelinePhase,
  output: unknown,
): {
  phase: ReviewPipelinePhase;
  topLevelKeys: string[];
  validator_requests?: Array<{ finding_id: string; file?: string; line?: number }>;
  validator_request_count?: number;
  validator_requests_truncated?: boolean;
  validator_requests_present?: boolean;
} {
  const isObject = output !== null && typeof output === "object" && !Array.isArray(output);
  const summary = {
    phase,
    topLevelKeys: isObject ? Object.keys(output).slice(0, 32).map((key) => key.slice(0, 128)) : [],
  };
  if (phase !== "merge" && phase !== "finalize") return summary;

  const mergeOutput = isObject ? output as Record<string, unknown> : undefined;
  const present = mergeOutput !== undefined && Object.prototype.hasOwnProperty.call(mergeOutput, "validator_requests");
  const rawRequests = present ? mergeOutput!.validator_requests : undefined;
  if (present && !Array.isArray(rawRequests)) {
    throw new ReviewPipelineError("review_pipeline_validator_requests_invalid", `validator_requests must be an array (observed ${rawRequests === null ? "null" : typeof rawRequests})`);
  }
  const requests = (rawRequests ?? []) as unknown[];
  const projected = requests.map((request, index) => {
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      throw new ReviewPipelineError("review_pipeline_validator_requests_invalid", `validator_requests entry at index ${index} must be an object`);
    }
    const entry = request as Record<string, unknown>;
    if (typeof entry.finding_id !== "string" || entry.finding_id.length === 0) {
      throw new ReviewPipelineError("review_pipeline_validator_requests_invalid", `validator_requests entry at index ${index} must have a non-empty string finding_id`);
    }
    const item: { finding_id: string; file?: string; line?: number } = {
      finding_id: entry.finding_id.slice(0, REVIEW_PIPELINE_MAX_VALIDATOR_FINDING_ID_LENGTH),
    };
    if (typeof entry.file === "string") item.file = entry.file.slice(0, REVIEW_PIPELINE_MAX_VALIDATOR_FILE_LENGTH);
    if (Number.isInteger(entry.line) && (entry.line as number) >= 0) item.line = entry.line as number;
    return item;
  }).slice(0, REVIEW_PIPELINE_MAX_VALIDATOR_REQUESTS);
  return {
    ...summary,
    validator_requests: projected,
    validator_request_count: requests.length,
    validator_requests_truncated: requests.length > projected.length,
    validator_requests_present: present,
  };
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
  if (phase !== "prepare" && Object.prototype.hasOwnProperty.call(payload, "selected_dispatches")) {
    throw new ReviewPipelineError("review_pipeline_selected_dispatches_phase_forbidden", `selected_dispatches is only valid for prepare (received ${phase})`);
  }
  if (phase === "screen") {
    if (typeof payload.reviewer !== "string" || !(REVIEW_PIPELINE_REVIEWERS as readonly string[]).includes(payload.reviewer)) {
      throw new ReviewPipelineError("review_pipeline_reviewer_invalid", "screen requires an enumerated reviewer persona");
    }
  } else if (payload.reviewer !== undefined) {
    throw new ReviewPipelineError("review_pipeline_reviewer_forbidden", "reviewer is only valid for screen");
  }
  assertReviewRunId(payload.runId);
  for (const field of ["prepared", "merge", "screen_results"] as const) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) throw new ReviewPipelineError(`review_pipeline_${field}_override_forbidden`, `caller may not supply helper-produced field ${field}`);
  }
  const hasStdin = payload.stdin !== undefined;
  const hasInputRef = payload.inputRef !== undefined;
  const hasInputRefs = payload.inputRefs !== undefined;
  let inputSource: ReviewPipelineInputSource | undefined = phase === "merge" ? "inputRef" : phase === "finalize" ? "inputRefs" : undefined;
  let input: Buffer;
  let composedInput = false;
  if (phase === "merge") { input = composeMerge(payload, storeContext); composedInput = true; }
  else if (phase === "finalize") { input = composeFinalize(payload, storeContext); composedInput = true; }
  else {
  for (const field of ["adjudication", "preparedRef", "mergeRef", "dispatch_records", "validator_lifecycle_results", "plan_assessment", "parent_run_metadata"] as const) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) throw new ReviewPipelineError(`review_pipeline_${field}_phase_forbidden`, `${field} is not valid for ${phase}`);
  }
  const sourceCount = Number(hasStdin) + Number(hasInputRef) + Number(hasInputRefs);
  if (sourceCount === 0) {
    throw new ReviewPipelineError("review_pipeline_stdin_source_missing", "exactly one of stdin, inputRef, or inputRefs must be supplied; none was provided");
  }
  if (sourceCount > 1) {
    throw new ReviewPipelineError("review_pipeline_stdin_source_conflict", "exactly one of stdin, inputRef, or inputRefs must be supplied; multiple sources were provided");
  }
  if (phase === "prepare" && Object.prototype.hasOwnProperty.call(payload, "selected_dispatches") && !hasInputRefs) {
    throw new ReviewPipelineError("review_pipeline_selected_dispatches_requires_input_refs", "selected_dispatches is only valid when inputRefs is supplied");
  }
  inputSource = hasStdin ? "stdin" : hasInputRef ? "inputRef" : "inputRefs";
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
    if (!Array.isArray(payload.selected_dispatches) || payload.selected_dispatches.length === 0) {
      throw new ReviewPipelineError("review_pipeline_selected_dispatches_missing", "prepare with inputRefs requires a non-empty selected_dispatches array");
    }
    const selectedDispatchBytes = callerBytes([["selected_dispatches", payload.selected_dispatches]]);
    const selectedDispatches = JSON.parse(selectedDispatchBytes[0]!.toString("utf8")) as unknown[];
    const selectedPersonas = new Set<string>();
    const uniqueSelectedDispatches: unknown[] = [];
    for (const dispatch of selectedDispatches) {
      if (dispatch === null || typeof dispatch !== "object" || Array.isArray(dispatch) || typeof (dispatch as Record<string, unknown>).persona !== "string") {
        throw new ReviewPipelineError("review_pipeline_selected_dispatches_invalid", "each selected_dispatches entry must be an object with a persona string");
      }
      const persona = (dispatch as Record<string, unknown>).persona as string;
      if (!selectedPersonas.has(persona)) uniqueSelectedDispatches.push(dispatch);
      selectedPersonas.add(persona);
    }
    const seenRefs = new Set<string>();
    const screenResults: { reviewer: string; result: Record<string, unknown> }[] = [];
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
      const persona = phaseMatch[2]!;
      if (!selectedPersonas.has(persona)) {
        throw new ReviewPipelineError("review_pipeline_input_refs_persona_unselected", `screen artifact persona is not selected: ${persona}`);
      }
      screenResults.push(wrapScreenResult(storeContext, payload.runId as string, ref));
    }
    for (const persona of selectedPersonas) {
      if (!seenRefs.has(`phase-screen-${persona}.json`)) {
        throw new ReviewPipelineError("review_pipeline_selected_dispatches_screen_missing", `selected dispatch has no matching screen artifact: ${persona}`);
      }
    }
    input = Buffer.from(JSON.stringify({
      screen_results: screenResults,
      selected_dispatches: uniqueSelectedDispatches,
    }), "utf8");
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
  }
  if ((composedInput || hasStdin || hasInputRefs) && input.byteLength > REVIEW_PIPELINE_MAX_STDIN_BYTES) {
    throw new ReviewPipelineError(
      composedInput ? "review_pipeline_composed_input_too_large" : hasInputRefs ? "review_pipeline_input_refs_too_large" : "review_pipeline_stdin_too_large",
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
    let summary: ReturnType<typeof createSummary> & { inputSource: ReviewPipelineInputSource };
    try {
      summary = { ...createSummary(phase, output), inputSource: inputSource! };
    } catch (cause) {
      if (!(cause instanceof ReviewPipelineError) || cause.code !== "review_pipeline_validator_requests_invalid") throw cause;
      return {
        outcome: "invalid_output",
        code: "review_pipeline_validator_requests_invalid",
        diagnostic: cause.message.slice(0, STDERR_MAX_BYTES),
        artifact: { name: artifact.name, bytes: artifact.bytes, sha256: artifact.sha256 },
        inputSource: inputSource!,
      };
    }
    if (phase === "finalize") {
      storeContext.store.recordFinalizeProvenance(storeContext.sessionID, payload.runId as string, { phase, outcome: "accepted", artifact, inputSource: inputSource! });
    }
    return { outcome: "accepted", artifact: { name: artifact.name, bytes: artifact.bytes, sha256: artifact.sha256 }, summary };
  }
  const stderrDiagnostic = diagnostic(result);
  const internalFailure = result.status === 1 && stderrDiagnostic.startsWith("ce-review-validator: internal error in ");
  if (phase === "finalize") {
    storeContext?.store.recordFinalizeProvenance(storeContext.sessionID, payload.runId as string, {
      phase,
      outcome: result.status === 1 && !internalFailure ? "structurally_rejected" : "validation_unavailable",
      inputSource: inputSource!,
    });
  }
  if (result.status === 1 && !internalFailure) return { outcome: "structurally_rejected", code: "review_pipeline_structurally_rejected", diagnostic: stderrDiagnostic };
  return { outcome: "validation_unavailable", code: "review_pipeline_validation_unavailable", diagnostic: stderrDiagnostic };
}
