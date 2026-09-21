import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ProjectConfig } from "./config.ts";
import type { SpawnFn } from "./msb.ts";
import type { ReviewLens } from "./types.ts";
import { capAndRedact } from "./gitops.ts";
import {
  assertEvidenceText,
  assertExpectedUntrackedInventory,
  assertIntendedUntracked,
  assertReviewIntendedUntracked,
  assertUntrackedScope,
  assertCanonicalRoots,
  assertExpectedRevision,
  assertLowercaseRequestId,
  assertIntendedUntrackedSelection,
  assertReviewRuntimeAgent,
  assertMaintainerAuthorization,
  assertOptionalBoolean,
  assertReviewBaseRef,
  assertReviewConsent,
  assertReviewCorrectionLines,
  assertReviewDisposition,
  assertReviewFocus,
  assertReviewGate,
  assertReviewInputJson,
  assertReviewLens,
  assertReviewLocale,
  assertReviewOrder,
  assertReviewProjection,
  assertReviewSha256,
  assertReviewToken,
  REVIEW_FOCUS_MAX_BYTES,
  assertMaxBytes,
  assertNoControlChars,
  assertPositiveInt,
  assertProjectRelativePath,
  assertSddContract,
  assertSddIdentifier,
  isWithin,
  resolveProjectID,
  resolveProjectRelativePath,
  ValidationError,
} from "./validation.ts";

const DEFAULT_OUTPUT_MAX_BYTES = 512 * 1024;
const STATUS_TIMEOUT_MS = 120_000;

export interface SddRuntimeResult {
  status: number | null;
  json: unknown;
  stderr: string;
}

/**
 * Tolerant result for read-only commands whose stdout is not guaranteed to be
 * JSON (e.g. `review mode status`): the raw text is preserved and `json` is set
 * only when stdout actually parses.
 */
export interface SddRawResult {
  status: number | null;
  text: string;
  stderr: string;
  json?: unknown;
}

export interface SddStatusArgvInput {
  binary: string;
  projectRoot: string;
  change?: string;
  contract?: string;
}

export interface SddContinueArgvInput {
  binary: string;
  projectRoot: string;
  change?: string;
}

export interface SddArchiveComposeArgvInput {
  binary: string;
  projectRoot: string;
  canonical: string;
  delta: string;
  output: string;
}

export interface SddTaskResultArgvInput {
  binary: string;
  projectRoot: string;
  phase: string;
  input: string;
}

export interface ReviewAssessArgvInput {
  binary: string;
  projectRoot: string;
  baseRef?: string;
  committedOnly?: boolean;
  untrackedScope?: "exclude" | "select";
  expectedUntrackedInventory?: string;
  intendedUntracked?: string[];
}

export interface ReviewModeStatusArgvInput {
  binary: string;
}

export interface ReviewStatusArgvInput {
  binary: string;
  projectRoot: string;
  agent?: string;
  lineage?: string;
  repositoryContext?: string;
  projection?: "workspace" | "staged";
  baseRef?: string;
  committedOnly?: boolean;
  intendedUntrackedSelection?: string;
}

export interface ReviewLensContextArgvInput {
  binary: string;
  projectRoot: string;
  repositoryContext: string;
  lineage: string;
  target: string;
  expectedRevision: string;
  lens: ReviewLens;
}

export interface SddAttemptGrantArgvInput {
  binary: string;
  projectRoot: string;
  change: string;
  expectedRevision?: string;
  roots: string[];
  changeInstance: string;
  requestId: string;
  actor: string;
  reason: string;
}

export interface SddRuntimeExecutorOptions {
  binary: string;
  projects: readonly ProjectConfig[];
  spawn: SpawnFn;
  outputMaxBytes?: number;
  reviewInputDir?: string;
}

export class SddRuntimeError extends Error {
  readonly code = "internal" as const;

  constructor(message: string) {
    super(message);
    this.name = "SddRuntimeError";
  }
}

function assertRecord(value: unknown, what: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${what} must be an object`);
  }
}

function assertProjectRootInput(projectRoot: unknown): asserts projectRoot is string {
  if (typeof projectRoot !== "string" || projectRoot.length === 0 || !isAbsolute(projectRoot)) {
    throw new ValidationError("project root must be a non-empty absolute path");
  }
  assertMaxBytes(projectRoot, 4096, "project root");
  assertNoControlChars(projectRoot, "project root");
}

function assertBinary(binary: unknown): asserts binary is string {
  if (typeof binary !== "string" || binary.length === 0) {
    throw new ValidationError("SDD runtime binary must be a non-empty string");
  }
  assertMaxBytes(binary, 4096, "SDD runtime binary");
  assertNoControlChars(binary, "SDD runtime binary");
}

function assertBoundedPositiveInt(value: unknown, max: number, what: string): asserts value is number {
  if (value === undefined || value === null) {
    throw new ValidationError(`${what} is required`);
  }
  assertPositiveInt(value, max, what);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ValidationError(`unexpected SDD runtime field '${key}'`);
  }
}

/**
 * `gentle-ai sdd-status [change] --cwd <root> --json --instructions`
 * with an optional allowlisted `--contract`.
 */
export function buildSddStatusArgv(input: SddStatusArgvInput): string[] {
  assertRecord(input, "status input");
  assertExactKeys(input, ["binary", "projectRoot", "change", "contract"]);
  assertBinary(input.binary);
  assertProjectRootInput(input.projectRoot);
  const argv = [input.binary, "sdd-status"];
  if (input.change !== undefined) {
    assertSddIdentifier(input.change, "change");
    argv.push(input.change);
  }
  argv.push("--cwd", input.projectRoot, "--json", "--instructions");
  if (input.contract !== undefined) {
    assertSddContract(input.contract);
    argv.push("--contract", input.contract);
  }
  return argv;
}

/** `gentle-ai sdd-continue [change] --cwd <root>` (no `--json`). */
export function buildSddContinueArgv(input: SddContinueArgvInput): string[] {
  assertRecord(input, "continue input");
  assertExactKeys(input, ["binary", "projectRoot", "change"]);
  assertBinary(input.binary);
  assertProjectRootInput(input.projectRoot);
  const argv = [input.binary, "sdd-continue"];
  if (input.change !== undefined) {
    assertSddIdentifier(input.change, "change");
    argv.push(input.change);
  }
  argv.push("--cwd", input.projectRoot);
  return argv;
}

/**
 * Bound a subprocess stderr tail for an error message. The CLI often prints the
 * actionable reason (e.g. a required untracked declaration) only to stderr, so
 * it must survive into the thrown error instead of being discarded.
 */
function boundedStderrSuffix(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return "";
  const bounded = Buffer.from(trimmed, "utf8")
    .subarray(0, MAX_ERROR_STDERR_BYTES)
    .toString("utf8");
  return `; stderr: ${bounded}`;
}

/** Paths resolve beneath the approved root; `-` is preserved verbatim. */
export function buildSddArchiveComposeArgv(input: SddArchiveComposeArgvInput): string[] {
  assertRecord(input, "archive compose input");
  assertExactKeys(input, ["binary", "projectRoot", "canonical", "delta", "output"]);
  assertBinary(input.binary);
  assertProjectRootInput(input.projectRoot);
  assertProjectRelativePath(input.canonical, "canonical");
  assertProjectRelativePath(input.delta, "delta");
  assertProjectRelativePath(input.output, "output");
  return [
    input.binary,
    "sdd-archive-compose",
    "--canonical",
    resolveProjectRelativePath(input.projectRoot, input.canonical, "canonical"),
    "--delta",
    resolveProjectRelativePath(input.projectRoot, input.delta, "delta"),
    "--output",
    resolveProjectRelativePath(input.projectRoot, input.output, "output"),
  ];
}

export function buildSddTaskResultArgv(input: SddTaskResultArgvInput): string[] {
  assertRecord(input, "task result input");
  assertExactKeys(input, ["binary", "projectRoot", "phase", "input"]);
  assertBinary(input.binary);
  assertProjectRootInput(input.projectRoot);
  assertSddIdentifier(input.phase, "phase");
  assertProjectRelativePath(input.input, "input");
  return [
    input.binary,
    "sdd-task-result",
    "--phase",
    input.phase,
    "--cwd",
    input.projectRoot,
    "--input",
    resolveProjectRelativePath(input.projectRoot, input.input, "input"),
  ];
}

/**
 * `gentle-ai review assess --cwd <root> [--base-ref <ref>] [--committed-only]
 * --json`.
 *
 * The upstream `review assess` scoping flags are optional: omitting both keeps
 * the unscoped argv byte-for-byte unchanged. Each supplied flag is forwarded
 * exactly; the upstream command owns the committed-range pairing rule.
 */
export function buildReviewAssessArgv(input: ReviewAssessArgvInput): string[] {
  assertRecord(input, "review assess input");
  assertExactKeys(input, [
    "binary",
    "projectRoot",
    "baseRef",
    "committedOnly",
    "untrackedScope",
    "expectedUntrackedInventory",
    "intendedUntracked",
  ]);
  assertBinary(input.binary);
  assertProjectRootInput(input.projectRoot);
  const argv = [input.binary, "review", "assess", "--cwd", input.projectRoot];
  if (input.baseRef !== undefined) {
    assertReviewBaseRef(input.baseRef);
    argv.push("--base-ref", input.baseRef);
  }
  if (input.committedOnly !== undefined) {
    assertOptionalBoolean(input.committedOnly, "committedOnly");
    if (input.committedOnly) argv.push("--committed-only");
  }
  if (input.untrackedScope !== undefined) {
    assertUntrackedScope(input.untrackedScope);
    argv.push(`--untracked-scope=${input.untrackedScope}`);
  }
  if (input.expectedUntrackedInventory !== undefined) {
    assertExpectedUntrackedInventory(input.expectedUntrackedInventory);
    argv.push(`--expected-untracked-inventory=${input.expectedUntrackedInventory}`);
  }
  if (input.intendedUntracked !== undefined) {
    assertIntendedUntracked(input.intendedUntracked);
    for (const path of input.intendedUntracked) {
      argv.push(`--intended-untracked=${path}`);
    }
  }
  argv.push("--json");
  return argv;
}

/** `gentle-ai review mode status` (no `--cwd`, no `--json`). */
export function buildReviewModeStatusArgv(input: ReviewModeStatusArgvInput): string[] {
  assertRecord(input, "review mode status input");
  assertExactKeys(input, ["binary"]);
  assertBinary(input.binary);
  return [input.binary, "review", "mode", "status"];
}

/**
 * `gentle-ai review status --cwd <root>
 * --contract gentle-ai.review-integration/v2 --agent <agent>
 * [--base-ref <ref>] [--committed-only] --next-transition`.
 *
 * The broker returns the raw JSON envelope unchanged; it never reshapes it.
 * `agent` defaults to `opencode` and must be a lowercase runtime identifier.
 */
export function buildReviewStatusArgv(input: ReviewStatusArgvInput): string[] {
  assertRecord(input, "review status input");
  assertExactKeys(input, [
    "binary",
    "projectRoot",
    "agent",
    "lineage",
    "repositoryContext",
    "projection",
    "baseRef",
    "committedOnly",
    "intendedUntrackedSelection",
  ]);
  assertBinary(input.binary);
  assertProjectRootInput(input.projectRoot);
  const agent = input.agent ?? DEFAULT_REVIEW_AGENT;
  assertReviewRuntimeAgent(agent);
  const argv = [
    input.binary,
    "review",
    "status",
    "--cwd",
    input.projectRoot,
    "--contract",
    "gentle-ai.review-integration/v2",
    "--agent",
    agent,
  ];
  if (input.lineage !== undefined) {
    assertReviewToken(input.lineage, "lineage");
    argv.push("--lineage", input.lineage);
  }
  if (input.repositoryContext !== undefined) {
    assertReviewToken(input.repositoryContext, "repositoryContext");
    argv.push("--repository-context", input.repositoryContext);
  }
  if (input.projection !== undefined) {
    assertReviewProjection(input.projection);
    argv.push("--projection", input.projection);
  }
  if (input.baseRef !== undefined) {
    assertReviewBaseRef(input.baseRef);
    argv.push("--base-ref", input.baseRef);
  }
  if (input.committedOnly !== undefined) {
    assertOptionalBoolean(input.committedOnly, "committedOnly");
    if (input.committedOnly) argv.push("--committed-only");
  }
  if (input.intendedUntrackedSelection !== undefined) {
    assertIntendedUntrackedSelection(input.intendedUntrackedSelection);
    argv.push(
      "--intended-untracked-selection",
      input.intendedUntrackedSelection,
    );
  }
  argv.push("--next-transition");
  return argv;
}

/**
 * `gentle-ai review lens-context --cwd <root> --repository-context <h>
 * --lineage <l> --target <t> --expected-revision <r> --lens <lens>`.
 *
 * Read-only: it returns the multi-line reviewer block (binding line plus the
 * GENTLE_AI_REVIEW_CONTEXT ... END delimiters) as plain text, so the executor
 * returns it through the tolerant raw path and never parses it as JSON.
 */
export function buildReviewLensContextArgv(input: ReviewLensContextArgvInput): string[] {
  assertRecord(input, "review lens context input");
  assertExactKeys(input, [
    "binary",
    "projectRoot",
    "repositoryContext",
    "lineage",
    "target",
    "expectedRevision",
    "lens",
  ]);
  assertBinary(input.binary);
  assertProjectRootInput(input.projectRoot);
  assertReviewToken(input.repositoryContext, "repositoryContext");
  assertReviewToken(input.lineage, "lineage");
  assertReviewToken(input.target, "target");
  assertReviewSha256(input.expectedRevision, "expectedRevision");
  assertReviewLens(input.lens);
  return [
    input.binary,
    "review",
    "lens-context",
    "--cwd",
    input.projectRoot,
    "--repository-context",
    input.repositoryContext,
    "--lineage",
    input.lineage,
    "--target",
    input.target,
    "--expected-revision",
    input.expectedRevision,
    "--lens",
    input.lens,
  ];
}

const RESET_REASON_MAX_BYTES = 500;
const LEDGER_ACTOR_MAX_BYTES = 128;

/**
 * `gentle-ai sdd-attempt grant ... [--expected-revision] --root <path>...
 * --change-instance <token> --request-id <id> --actor <actor> --reason <text>`.
 * Roots are preserved in order; an initial grant may omit the CAS revision.
 */
export function buildSddAttemptGrantArgv(input: SddAttemptGrantArgvInput): string[] {
  assertRecord(input, "attempt grant input");
  assertExactKeys(input, [
    "binary",
    "projectRoot",
    "change",
    "expectedRevision",
    "roots",
    "changeInstance",
    "requestId",
    "actor",
    "reason",
  ]);
  assertBinary(input.binary);
  assertProjectRootInput(input.projectRoot);
  assertSddIdentifier(input.change, "change");
  if (input.expectedRevision !== undefined) assertExpectedRevision(input.expectedRevision);
  assertCanonicalRoots(input.roots);
  assertEvidenceText(input.changeInstance, "changeInstance", LEDGER_ACTOR_MAX_BYTES);
  assertLowercaseRequestId(input.requestId);
  assertEvidenceText(input.actor, "actor", LEDGER_ACTOR_MAX_BYTES);
  assertEvidenceText(input.reason, "reason", RESET_REASON_MAX_BYTES);
  const argv = [
    input.binary,
    "sdd-attempt",
    "grant",
    "--cwd",
    input.projectRoot,
    "--change",
    input.change,
  ];
  if (input.expectedRevision !== undefined) {
    argv.push("--expected-revision", input.expectedRevision);
  }
  for (const root of input.roots) {
    argv.push("--root", root);
  }
  argv.push(
    "--change-instance",
    input.changeInstance,
    "--request-id",
    input.requestId,
    "--actor",
    input.actor,
    "--reason",
    input.reason,
  );
  return argv;
}

export class SddRuntimeExecutor {
  private readonly outputMaxBytes: number;

  constructor(private readonly options: SddRuntimeExecutorOptions) {
    assertBinary(options.binary);
    const outputMaxBytes = options.outputMaxBytes ?? DEFAULT_OUTPUT_MAX_BYTES;
    if (!Number.isInteger(outputMaxBytes) || outputMaxBytes <= 0) {
      throw new ValidationError("SDD runtime output cap must be a positive integer");
    }
    this.outputMaxBytes = outputMaxBytes;
    if (options.reviewInputDir !== undefined) {
      cleanupStaleReviewInputs(options.reviewInputDir);
    }
  }

  resolveProjectRoot(projectDir: unknown): string {
    const projectID = resolveProjectID(projectDir, this.options.projects);
    const project = this.options.projects.find((entry) => entry.id === projectID);
    if (!project) throw new ValidationError("project is not in the trusted allowlist");
    let canonicalRoot: string;
    let canonicalRequested: string;
    try {
      canonicalRoot = realpathSync(project.path);
      canonicalRequested = realpathSync(projectDir as string);
    } catch {
      throw new ValidationError("project root does not resolve on the host");
    }
    if (canonicalRequested !== canonicalRoot) {
      throw new ValidationError("SDD runtime requires the exact approved project root");
    }
    return canonicalRoot;
  }

  async status(
    projectDir: unknown,
    options: { change?: unknown; contract?: unknown } = {},
  ): Promise<SddRuntimeResult> {
    const projectRoot = this.resolveProjectRoot(projectDir);
    return this.run(
      buildSddStatusArgv({
        binary: this.options.binary,
        projectRoot,
        ...(options.change !== undefined ? { change: options.change as string } : {}),
        ...(options.contract !== undefined ? { contract: options.contract as string } : {}),
      }),
      projectRoot,
    );
  }

  async sddContinue(payload: { projectDir: unknown; change?: unknown }): Promise<SddRuntimeResult> {
    const projectRoot = this.resolveProjectRoot(payload.projectDir);
    return this.run(
      buildSddContinueArgv({
        binary: this.options.binary,
        projectRoot,
        ...(payload.change !== undefined ? { change: payload.change as string } : {}),
      }),
      projectRoot,
    );
  }

  async archiveCompose(payload: {
    projectDir: unknown;
    canonical: unknown;
    delta: unknown;
    output: unknown;
  }): Promise<SddRuntimeResult> {
    const projectRoot = this.resolveProjectRoot(payload.projectDir);
    return this.run(
      buildSddArchiveComposeArgv({
        binary: this.options.binary,
        projectRoot,
        canonical: payload.canonical as string,
        delta: payload.delta as string,
        output: payload.output as string,
      }),
      projectRoot,
    );
  }

  async taskResult(payload: {
    projectDir: unknown;
    phase: unknown;
    input: unknown;
  }): Promise<SddRuntimeResult> {
    const projectRoot = this.resolveProjectRoot(payload.projectDir);
    return this.run(
      buildSddTaskResultArgv({
        binary: this.options.binary,
        projectRoot,
        phase: payload.phase as string,
        input: payload.input as string,
      }),
      projectRoot,
    );
  }

  async reviewAssess(payload: {
    projectDir: unknown;
    baseRef?: unknown;
    committedOnly?: unknown;
    untrackedScope?: unknown;
    expectedUntrackedInventory?: unknown;
    intendedUntracked?: unknown;
  }): Promise<SddRuntimeResult> {
    const projectRoot = this.resolveProjectRoot(payload.projectDir);
    return this.run(
      buildReviewAssessArgv({
        binary: this.options.binary,
        projectRoot,
        ...(payload.baseRef !== undefined ? { baseRef: payload.baseRef as string } : {}),
        ...(payload.committedOnly !== undefined
          ? { committedOnly: payload.committedOnly as boolean }
          : {}),
        ...(payload.untrackedScope !== undefined
          ? { untrackedScope: payload.untrackedScope as "exclude" | "select" }
          : {}),
        ...(payload.expectedUntrackedInventory !== undefined
          ? { expectedUntrackedInventory: payload.expectedUntrackedInventory as string }
          : {}),
        ...(payload.intendedUntracked !== undefined
          ? { intendedUntracked: payload.intendedUntracked as string[] }
          : {}),
      }),
      projectRoot,
    );
  }

  /**
   * Read-only `review mode status`. Its stdout is not contractually JSON, so a
   * non-JSON body is preserved as text instead of failing the command.
   */
  async reviewModeStatus(payload: { projectDir: unknown }): Promise<SddRawResult> {
    const projectRoot = this.resolveProjectRoot(payload.projectDir);
    return this.runRaw(
      buildReviewModeStatusArgv({ binary: this.options.binary }),
      projectRoot,
    );
  }

  /**
   * Read-only `review status`. The command emits a JSON envelope; the broker
   * returns it via the standard SDD result shape without reshaping it.
   */
  async reviewStatus(payload: {
    projectDir: unknown;
    agent?: unknown;
    lineage?: unknown;
    repositoryContext?: unknown;
    projection?: unknown;
    baseRef?: unknown;
    committedOnly?: unknown;
    intendedUntrackedSelection?: unknown;
  }): Promise<SddRuntimeResult> {
    const projectRoot = this.resolveProjectRoot(payload.projectDir);
    return this.run(
      buildReviewStatusArgv({
        binary: this.options.binary,
        projectRoot,
        ...(payload.agent !== undefined ? { agent: payload.agent as string } : {}),
        ...(payload.lineage !== undefined ? { lineage: payload.lineage as string } : {}),
        ...(payload.repositoryContext !== undefined
          ? { repositoryContext: payload.repositoryContext as string }
          : {}),
        ...(payload.projection !== undefined
          ? { projection: payload.projection as "workspace" | "staged" }
          : {}),
        ...(payload.baseRef !== undefined ? { baseRef: payload.baseRef as string } : {}),
        ...(payload.committedOnly !== undefined
          ? { committedOnly: payload.committedOnly as boolean }
          : {}),
        ...(payload.intendedUntrackedSelection !== undefined
          ? {
              intendedUntrackedSelection:
                payload.intendedUntrackedSelection as string,
            }
          : {}),
      }),
      projectRoot,
    );
  }

  /**
   * Read-only per-lens reviewer context. The command prints a multi-line
   * plain-text block (binding line plus the GENTLE_AI_REVIEW_CONTEXT ... END
   * delimiters), so it uses the tolerant raw path and is never JSON-parsed.
   */
  async reviewLensContext(payload: {
    projectDir: unknown;
    repositoryContext: unknown;
    lineage: unknown;
    target: unknown;
    expectedRevision: unknown;
    lens: unknown;
  }): Promise<SddRawResult> {
    const projectRoot = this.resolveProjectRoot(payload.projectDir);
    return this.runRaw(
      buildReviewLensContextArgv({
        binary: this.options.binary,
        projectRoot,
        repositoryContext: payload.repositoryContext as string,
        lineage: payload.lineage as string,
        target: payload.target as string,
        expectedRevision: payload.expectedRevision as string,
        lens: payload.lens as ReviewLens,
      }),
      projectRoot,
    );
  }

  async attemptGrant(payload: {
    projectDir: unknown;
    change: unknown;
    expectedRevision?: unknown;
    roots: unknown;
    changeInstance: unknown;
    requestId: unknown;
    actor: unknown;
    reason: unknown;
  }): Promise<SddRuntimeResult> {
    const projectRoot = this.resolveProjectRoot(payload.projectDir);
    return this.run(
      buildSddAttemptGrantArgv({
        binary: this.options.binary,
        projectRoot,
        change: payload.change as string,
        ...(payload.expectedRevision !== undefined
          ? { expectedRevision: payload.expectedRevision as string }
          : {}),
        roots: payload.roots as string[],
        changeInstance: payload.changeInstance as string,
        requestId: payload.requestId as string,
        actor: payload.actor as string,
        reason: payload.reason as string,
      }),
      projectRoot,
      true,
    );
  }

  private async runReview(operation: string, payload: Record<string, unknown>): Promise<SddRuntimeResult> {
    const projectRoot = this.resolveProjectRoot(payload.projectDir);
    return this.run(
      buildReviewArgv(operation, {
        binary: this.options.binary,
        projectRoot,
        ...withoutProjectDir(payload),
      }),
      projectRoot,
      true,
    );
  }

  async reviewCaptureResult(payload: Record<string, unknown>): Promise<SddRuntimeResult> {
    const projectRoot = this.resolveProjectRoot(payload.projectDir);
    const rawInput = payload.input;
    const rawInputJson = payload.inputJson;
    if (rawInput !== undefined && rawInputJson !== undefined) {
      throw new ValidationError("input and inputJson are mutually exclusive");
    }
    const { inputJson: _inputJson, ...rest } = withoutProjectDir(payload);
    let stagedInput: string | undefined;
    if (rawInput !== undefined) {
      stagedInput =
        rawInput === "-"
          ? "-"
          : stageReviewInputFile(this.requireReviewInputDir(), projectRoot, rawInput as string);
    } else if (rawInputJson !== undefined) {
      assertReviewInputJson(rawInputJson, REVIEW_INPUT_MAX_BYTES);
      stagedInput = stageReviewInputJson(this.requireReviewInputDir(), rawInputJson);
    }
    try {
      return await this.run(
        buildReviewArgv("reviewCaptureResult", {
          binary: this.options.binary,
          projectRoot,
          ...rest,
          ...(stagedInput !== undefined ? { input: stagedInput } : {}),
        }),
        projectRoot,
        true,
      );
    } finally {
      if (stagedInput !== undefined && stagedInput !== "-") {
        try {
          unlinkSync(stagedInput);
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }

  async reviewAcknowledgeApproved(payload: Record<string, unknown>): Promise<SddRuntimeResult> {
    const projectRoot = this.resolveProjectRoot(payload.projectDir);
    return this.run(
      buildReviewAcknowledgeApprovedArgv({
        binary: this.options.binary,
        ...withoutProjectDir(payload),
      }),
      projectRoot,
      true,
    );
  }

  async reviewStart(payload: Record<string, unknown>): Promise<SddRuntimeResult> {
    return this.runReview("reviewStart", payload);
  }
  async reviewCaptureUnachievable(payload: Record<string, unknown>): Promise<SddRuntimeResult> {
    return this.runReview("reviewCaptureUnachievable", payload);
  }
  async reviewCaptureCorrectionPlan(payload: Record<string, unknown>): Promise<SddRuntimeResult> {
    return this.runReview("reviewCaptureCorrectionPlan", payload);
  }
  async reviewCaptureRefuter(payload: Record<string, unknown>): Promise<SddRuntimeResult> {
    return this.runReview("reviewCaptureRefuter", payload);
  }
  async reviewCaptureValidation(payload: Record<string, unknown>): Promise<SddRuntimeResult> {
    return this.runReview("reviewCaptureValidation", payload);
  }
  async reviewValidate(payload: Record<string, unknown>): Promise<SddRuntimeResult> {
    return this.runReview("reviewValidate", payload);
  }
  async reviewRecover(payload: Record<string, unknown>): Promise<SddRuntimeResult> {
    return this.runReview("reviewRecover", payload);
  }

  private requireReviewInputDir(): string {
    const dir = this.options.reviewInputDir;
    if (!dir) throw new SddRuntimeError("review input staging is not configured");
    return dir;
  }

  private async run(
    argv: string[],
    projectRoot: string,
    redactOutput = false,
  ): Promise<SddRuntimeResult> {
    const result = await this.options.spawn(argv, {
      cwd: projectRoot,
      timeoutMs: STATUS_TIMEOUT_MS,
      maxOutputBytes: this.outputMaxBytes,
      env: { NO_COLOR: "1" },
    });
    if (result.timedOut) throw new SddRuntimeError("SDD runtime command timed out");
    // stdout carries provider-issued lifecycle tokens that later argv
    // positions must receive verbatim, so it is returned exactly as emitted.
    // The spawn already enforces `maxOutputBytes` (512 KiB); only
    // stderr/diagnostics are redacted and capped here.
    const stdout = result.stdout;
    const stderr = redactOutput ? capAndRedact(result.stderr) : result.stderr;
    if (stdout.trim().length === 0) {
      throw new SddRuntimeError(
        `SDD runtime returned empty stdout; expected JSON${boundedStderrSuffix(stderr)}`,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(stdout);
    } catch {
      throw new SddRuntimeError(
        `SDD runtime returned non-JSON stdout${boundedStderrSuffix(stderr)}`,
      );
    }
    return { status: result.status, json, stderr };
  }

  private async runRaw(argv: string[], projectRoot: string): Promise<SddRawResult> {
    const result = await this.options.spawn(argv, {
      cwd: projectRoot,
      timeoutMs: STATUS_TIMEOUT_MS,
      maxOutputBytes: this.outputMaxBytes,
      env: { NO_COLOR: "1" },
    });
    if (result.timedOut) throw new SddRuntimeError("SDD runtime command timed out");
    const text = result.stdout;
    const trimmed = text.trim();
    let json: unknown;
    if (trimmed.length > 0) {
      try {
        json = JSON.parse(trimmed);
      } catch {
        json = undefined;
      }
    }
    return { status: result.status, text, stderr: result.stderr, json };
  }
}
const DEFAULT_REVIEW_AGENT = "opencode";
const MAX_ERROR_STDERR_BYTES = 4096;

// ---------------------------------------------------------------------------
// Host review lifecycle fixed-argv builders (provider tokens verbatim)
// ---------------------------------------------------------------------------

/** Payload key reserved for the shared untracked declaration. */
const REVIEW_UNTRACKED_KEY = "__untracked";

/** How one optional review payload field is validated and emitted. */
type ReviewFieldKind =
  | "agent"
  | "token"
  | "focus"
  | "baseRef"
  | "sha256"
  | "order"
  | "correctionLines"
  | "boolean"
  | "enum"
  | "reason"
  | "detail"
  | "actor"
  | "maintainerAuth"
  | "stagedInput"
  | "untracked";

interface ReviewFlagSpec {
  key: string;
  flag?: string;
  kind: ReviewFieldKind;
  values?: readonly string[];
  /** When true the value must be present and non-empty; refusal names the flag. */
  required?: boolean;
}

interface ReviewCommandSpec {
  command: readonly string[];
  needsRoot: boolean;
  emitCwd: boolean;
  untracked?: boolean;
  fields: readonly ReviewFlagSpec[];
}

const REVIEW_COMMANDS: Record<string, ReviewCommandSpec> = {
  reviewStart: {
    command: ["review", "start"],
    needsRoot: true,
    emitCwd: true,
    untracked: true,
    fields: [
      { key: "agent", flag: "--agent", kind: "agent" },
      { key: "contract", flag: "--contract", kind: "token" },
      { key: "target", flag: "--target", kind: "token" },
      { key: "projection", flag: "--projection", kind: "enum", values: ["workspace", "staged"] },
      { key: "focus", flag: "--focus", kind: "enum", values: ["risk", "resilience", "readability", "reliability"] },
      { key: REVIEW_UNTRACKED_KEY, kind: "untracked" },
      { key: "baseRef", flag: "--base-ref", kind: "baseRef" },
      { key: "committedOnly", flag: "--committed-only", kind: "boolean" },
      { key: "workspaceOverlay", flag: "--workspace-overlay", kind: "boolean" },
      { key: "lineage", flag: "--lineage", kind: "token" },
      { key: "consent", flag: "--consent", kind: "enum", values: ["relay", "granted", "declined"] },
      { key: "locale", flag: "--locale", kind: "enum", values: ["en", "es"] },
      { key: "policy", flag: "--policy", kind: "token" },
      { key: "trace", flag: "--trace", kind: "token" },
    ],
  },
  reviewCaptureResult: {
    command: ["review", "capture-result"],
    needsRoot: true,
    emitCwd: true,
    fields: [
      { key: "agent", flag: "--agent", kind: "agent" },
      { key: "input", flag: "--input", kind: "stagedInput" },
      { key: "lens", flag: "--lens", kind: "token" },
      { key: "order", flag: "--order", kind: "order" },
      { key: "target", flag: "--target", kind: "token" },
      { key: "lineage", flag: "--lineage", kind: "token" },
      { key: "expectedRevision", flag: "--expected-revision", kind: "sha256" },
      { key: "repositoryContext", flag: "--repository-context", kind: "token" },
      { key: "subjectHash", flag: "--subject-hash", kind: "sha256" },
      { key: "materialize", flag: "--materialize", kind: "boolean" },
      { key: "preflight", flag: "--preflight", kind: "boolean" },
    ],
  },
  reviewCaptureUnachievable: {
    command: ["review", "capture-unachievable"],
    needsRoot: true,
    emitCwd: true,
    fields: [
      { key: "target", flag: "--target", kind: "token" },
      { key: "lineage", flag: "--lineage", kind: "token" },
      { key: "expectedRevision", flag: "--expected-revision", kind: "sha256" },
      { key: "repositoryContext", flag: "--repository-context", kind: "token" },
      { key: "requestHash", flag: "--request-hash", kind: "sha256" },
      { key: "reason", flag: "--reason", kind: "reason" },
      { key: "detail", flag: "--detail", kind: "detail" },
      { key: "withdraw", flag: "--withdraw", kind: "boolean" },
    ],
  },
  reviewAcknowledgeApproved: {
    command: ["review", "acknowledge-approved"],
    needsRoot: false,
    emitCwd: false,
    fields: [
      { key: "lineage", flag: "--lineage", kind: "token", required: true },
      { key: "target", flag: "--target", kind: "token", required: true },
      { key: "expectedRevision", flag: "--expected-revision", kind: "sha256", required: true },
      { key: "token", flag: "--token", kind: "token", required: true },
    ],
  },
  reviewCaptureCorrectionPlan: {
    command: ["review", "capture-correction-plan"],
    needsRoot: true,
    emitCwd: true,
    fields: [
      { key: "target", flag: "--target", kind: "token" },
      { key: "lineage", flag: "--lineage", kind: "token" },
      { key: "expectedRevision", flag: "--expected-revision", kind: "sha256" },
      { key: "repositoryContext", flag: "--repository-context", kind: "token" },
      { key: "requestHash", flag: "--request-hash", kind: "sha256" },
      { key: "correctionLines", flag: "--correction-lines", kind: "correctionLines" },
    ],
  },
  reviewCaptureRefuter: {
    command: ["review", "capture-refuter"],
    needsRoot: true,
    emitCwd: true,
    fields: [
      { key: "agent", flag: "--agent", kind: "agent" },
      { key: "target", flag: "--target", kind: "token" },
      { key: "lineage", flag: "--lineage", kind: "token" },
      { key: "expectedRevision", flag: "--expected-revision", kind: "sha256" },
      { key: "repositoryContext", flag: "--repository-context", kind: "token" },
      { key: "materialize", flag: "--materialize", kind: "boolean" },
      { key: "execute", flag: "--execute", kind: "boolean" },
    ],
  },
  reviewCaptureValidation: {
    command: ["review", "capture-validation"],
    needsRoot: true,
    emitCwd: true,
    fields: [
      { key: "agent", flag: "--agent", kind: "agent" },
      { key: "target", flag: "--target", kind: "token" },
      { key: "lineage", flag: "--lineage", kind: "token" },
      { key: "expectedRevision", flag: "--expected-revision", kind: "sha256" },
      { key: "repositoryContext", flag: "--repository-context", kind: "token" },
      { key: "requestHash", flag: "--request-hash", kind: "sha256" },
      { key: "materialize", flag: "--materialize", kind: "boolean" },
      { key: "execute", flag: "--execute", kind: "boolean" },
    ],
  },
  reviewValidate: {
    command: ["review", "validate"],
    needsRoot: true,
    emitCwd: true,
    fields: [
      { key: "contract", flag: "--contract", kind: "token" },
      { key: "gate", flag: "--gate", kind: "enum", values: ["post-apply", "pre-commit", "pre-push", "pre-pr", "release"] },
      { key: "baseRef", flag: "--base-ref", kind: "baseRef" },
      { key: "lineage", flag: "--lineage", kind: "token" },
      { key: "policy", flag: "--policy", kind: "token" },
      { key: "prePrCiAttestation", flag: "--pre-pr-ci-attestation", kind: "token" },
      { key: "releaseConfiguration", flag: "--release-configuration", kind: "token" },
      { key: "releaseEvidenceFreshness", flag: "--release-evidence-freshness", kind: "token" },
      { key: "releaseGenerated", flag: "--release-generated", kind: "token" },
      { key: "releaseProvenance", flag: "--release-provenance", kind: "token" },
      { key: "releasePublicationBoundary", flag: "--release-publication-boundary", kind: "token" },
    ],
  },
  reviewRecover: {
    command: ["review", "recover"],
    needsRoot: true,
    emitCwd: true,
    untracked: true,
    fields: [
      { key: "actor", flag: "--actor", kind: "actor" },
      { key: "disposition", flag: "--disposition", kind: "enum", values: ["scope_changed", "invalidated", "escalated"] },
      { key: "expectedPredecessorRevision", flag: "--expected-predecessor-revision", kind: "sha256" },
      { key: "predecessorLineage", flag: "--predecessor-lineage", kind: "token" },
      { key: "successorLineage", flag: "--successor-lineage", kind: "token" },
      { key: "reason", flag: "--reason", kind: "reason" },
      { key: "maintainerAuthorization", flag: "--maintainer-authorization", kind: "maintainerAuth" },
      { key: "baseRef", flag: "--base-ref", kind: "baseRef" },
      { key: "committedOnly", flag: "--committed-only", kind: "boolean" },
      { key: "workspaceOverlay", flag: "--workspace-overlay", kind: "boolean" },
      { key: "releaseScope", flag: "--release-scope", kind: "boolean" },
      { key: "projection", flag: "--projection", kind: "enum", values: ["workspace", "staged"] },
      { key: REVIEW_UNTRACKED_KEY, kind: "untracked" },
      { key: "focus", flag: "--focus", kind: "focus" },
      { key: "policy", flag: "--policy", kind: "token" },
    ],
  },
};

/** The staged argv value: literal `-` or a broker-private absolute path. */
function assertStagedReviewInput(value: unknown): asserts value is string {
  if (value === "-") return;
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    throw new ValidationError("input must be '-' or a broker-staged absolute path");
  }
  assertMaxBytes(value, 4096, "input");
  assertNoControlChars(value, "input");
  if (value.startsWith("-")) {
    throw new ValidationError("input must not start with '-'");
  }
}

/** Validate and emit one optional review field, preserving its exact bytes. */
function applyReviewField(argv: string[], field: ReviewFlagSpec, value: unknown): void {
  switch (field.kind) {
    case "agent":
      assertReviewRuntimeAgent(value);
      argv.push(field.flag!, value as string);
      return;
    case "token":
      assertReviewToken(value, field.key);
      argv.push(field.flag!, value as string);
      return;
    case "focus":
      assertReviewToken(value, field.key, REVIEW_FOCUS_MAX_BYTES);
      argv.push(field.flag!, value as string);
      return;
    case "baseRef":
      assertReviewBaseRef(value);
      argv.push(field.flag!, value as string);
      return;
    case "sha256":
      assertReviewSha256(value, field.key);
      argv.push(field.flag!, value as string);
      return;
    case "order":
      assertReviewOrder(value);
      argv.push(field.flag!, String(value));
      return;
    case "correctionLines":
      assertReviewCorrectionLines(value);
      argv.push(field.flag!, String(value));
      return;
    case "boolean":
      assertOptionalBoolean(value, field.key);
      if (value === true) argv.push(field.flag!);
      return;
    case "enum":
      if (field.values === undefined || !field.values.includes(value as string)) {
        throw new ValidationError(`${field.key} must be one of: ${(field.values ?? []).join(", ")}`);
      }
      argv.push(field.flag!, value as string);
      return;
    case "reason":
      assertEvidenceText(value, field.key, 4096);
      argv.push(field.flag!, value as string);
      return;
    case "detail":
      assertEvidenceText(value, field.key, 16384);
      argv.push(field.flag!, value as string);
      return;
    case "actor":
      assertEvidenceText(value, field.key, 128);
      argv.push(field.flag!, value as string);
      return;
    case "maintainerAuth":
      assertMaintainerAuthorization(value);
      argv.push(field.flag!, value as string);
      return;
    case "stagedInput":
      assertStagedReviewInput(value);
      argv.push(field.flag!, value as string);
      return;
    default:
      throw new ValidationError("unknown review field kind");
  }
}

/** Shared untracked-declaration input for review commands. */
interface UntrackedDeclarationInput {
  projectRoot: string;
  untrackedScope?: "exclude" | "select";
  expectedUntrackedInventory?: string;
  intendedUntracked?: string[];
}

/**
 * Append the untracked declaration flags. `untrackedScope` and
 * `expectedUntrackedInventory` must be supplied together; `select` requires at
 * least one repo-relative `intendedUntracked` path, and `exclude` forbids them.
 */
function appendUntrackedDeclaration(argv: string[], input: UntrackedDeclarationInput, options: { unique?: boolean } = {}): void {
  const { untrackedScope, expectedUntrackedInventory, intendedUntracked } = input;
  if (untrackedScope === undefined) {
    if (expectedUntrackedInventory !== undefined) {
      throw new ValidationError("expectedUntrackedInventory requires untrackedScope");
    }
    if (intendedUntracked !== undefined) {
      throw new ValidationError("intendedUntracked requires untrackedScope 'select'");
    }
    return;
  }
  assertUntrackedScope(untrackedScope);
  assertExpectedUntrackedInventory(expectedUntrackedInventory);
  argv.push("--untracked-scope", untrackedScope);
  argv.push("--expected-untracked-inventory", expectedUntrackedInventory);
  if (untrackedScope === "exclude") {
    if (intendedUntracked !== undefined) {
      throw new ValidationError("untrackedScope 'exclude' must not carry intendedUntracked");
    }
    return;
  }
  if (options.unique) {
    assertReviewIntendedUntracked(intendedUntracked);
  } else {
    assertIntendedUntracked(intendedUntracked);
  }
  if (intendedUntracked.length === 0) {
    throw new ValidationError("untrackedScope 'select' requires at least one intendedUntracked path");
  }
  for (const path of intendedUntracked) {
    resolveProjectRelativePath(input.projectRoot, path, "intendedUntracked path");
    argv.push("--intended-untracked", path);
  }
}

/** Build one review argv from the frozen command spec; never reconstruct tokens. */
function buildReviewArgv(operation: string, input: Record<string, unknown>): string[] {
  const spec = REVIEW_COMMANDS[operation];
  if (!spec) throw new ValidationError(`unknown review operation: ${operation}`);
  const allowedKeys = ["binary"];
  for (const field of spec.fields) {
    if (field.key !== REVIEW_UNTRACKED_KEY) allowedKeys.push(field.key);
  }
  if (spec.needsRoot) allowedKeys.push("projectRoot");
  if (spec.untracked) {
    allowedKeys.push("untrackedScope", "expectedUntrackedInventory", "intendedUntracked");
  }
  assertRecord(input, `${operation} input`);
  assertExactKeys(input, allowedKeys);
  assertBinary(input.binary);
  const argv = [input.binary as string, ...spec.command];
  if (spec.needsRoot) {
    assertProjectRootInput(input.projectRoot);
    if (spec.emitCwd) argv.push("--cwd", input.projectRoot as string);
  }
  for (const field of spec.fields) {
    if (field.key === REVIEW_UNTRACKED_KEY) {
      appendUntrackedDeclaration(
        argv,
        {
          projectRoot: input.projectRoot as string,
          untrackedScope: input.untrackedScope as "exclude" | "select" | undefined,
          expectedUntrackedInventory: input.expectedUntrackedInventory as string | undefined,
          intendedUntracked: input.intendedUntracked as string[] | undefined,
        },
        { unique: true },
      );
      continue;
    }
    const value = input[field.key];
    if (value === undefined) {
      if (field.required) throw new ValidationError(`${field.flag} is required`);
      continue;
    }
    if (field.required && value === "") {
      throw new ValidationError(`${field.flag} is required`);
    }
    applyReviewField(argv, field, value);
  }
  return argv;
}

/** Drop the caller-facing `projectDir`, which the executor resolves separately. */
function withoutProjectDir(payload: Record<string, unknown>): Record<string, unknown> {
  const { projectDir: _projectDir, ...rest } = payload;
  return rest;
}

export function buildReviewStartArgv(input: Record<string, unknown>): string[] {
  return buildReviewArgv("reviewStart", input);
}
export function buildReviewCaptureResultArgv(input: Record<string, unknown>): string[] {
  return buildReviewArgv("reviewCaptureResult", input);
}
export function buildReviewCaptureUnachievableArgv(input: Record<string, unknown>): string[] {
  return buildReviewArgv("reviewCaptureUnachievable", input);
}
export function buildReviewAcknowledgeApprovedArgv(input: Record<string, unknown>): string[] {
  return buildReviewArgv("reviewAcknowledgeApproved", input);
}
export function buildReviewCaptureCorrectionPlanArgv(input: Record<string, unknown>): string[] {
  return buildReviewArgv("reviewCaptureCorrectionPlan", input);
}
export function buildReviewCaptureRefuterArgv(input: Record<string, unknown>): string[] {
  return buildReviewArgv("reviewCaptureRefuter", input);
}
export function buildReviewCaptureValidationArgv(input: Record<string, unknown>): string[] {
  return buildReviewArgv("reviewCaptureValidation", input);
}
export function buildReviewValidateArgv(input: Record<string, unknown>): string[] {
  return buildReviewArgv("reviewValidate", input);
}
export function buildReviewRecoverArgv(input: Record<string, unknown>): string[] {
  return buildReviewArgv("reviewRecover", input);
}

/** Broker-private directory name for staged review-capture inputs. */
export const REVIEW_INPUT_DIR_NAME = "review-input";
/** Hard cap for a staged review-capture input snapshot. */
export const REVIEW_INPUT_MAX_BYTES = 512 * 1024;

/** Remove every leftover staged review-input snapshot in a broker-private dir. */
export function cleanupStaleReviewInputs(dir: string): number {
  let removed = 0;
  try {
    for (const entry of readdirSync(dir)) {
      try {
        unlinkSync(join(dir, entry));
        removed += 1;
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* directory absent: nothing to clean */
  }
  return removed;
}

/**
 * Snapshot one validated regular project file into a private, immutable 0600
 * copy OUTSIDE the project tree (a sibling of the broker state).
 */
function stageReviewInputFile(inputDir: string, projectRoot: string, relative: string): string {
  const resolved = resolveProjectRelativePath(projectRoot, relative, "input");
  // The lexical resolver above only checks the pathname; a symlink inside the
  // project can still resolve outside it, so canonicalize and re-check
  // containment before any stat or read follows the link.
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(projectRoot);
    real = realpathSync(resolved);
  } catch {
    throw new ValidationError("review input does not resolve to a file on the host");
  }
  if (!isWithin(realRoot, real)) {
    throw new ValidationError("review input escapes the approved project root");
  }
  let stat;
  try {
    stat = statSync(real);
  } catch {
    throw new ValidationError("review input does not resolve to a file on the host");
  }
  if (!stat.isFile()) {
    throw new ValidationError("review input must be a regular file");
  }
  if (stat.size > REVIEW_INPUT_MAX_BYTES) {
    throw new ValidationError(`review input exceeds ${REVIEW_INPUT_MAX_BYTES} bytes`);
  }
  return writeStagedReviewInput(inputDir, readFileSync(real));
}

/**
 * Stage an inline review-capture body (`inputJson`) as the same private 0600
 * snapshot used for file inputs, so no repository temp file is ever written.
 */
function stageReviewInputJson(inputDir: string, body: string): string {
  return writeStagedReviewInput(inputDir, Buffer.from(body, "utf8"));
}

/** Write bytes to a fresh private `${inputDir}/<random>.input` snapshot. */
function writeStagedReviewInput(inputDir: string, bytes: Buffer): string {
  mkdirSync(inputDir, { recursive: true, mode: 0o700 });
  for (;;) {
    const candidate = join(inputDir, `${randomBytes(16).toString("hex")}.input`);
    let fd: number;
    try {
      fd = openSync(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return candidate;
  }
}
