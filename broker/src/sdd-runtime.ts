import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ProjectConfig } from "./config.ts";
import type { SpawnFn } from "./msb.ts";
import {
  assertMaxBytes,
  assertNoControlChars,
  assertNoShellMetachars,
  assertPositiveInt,
  assertRequestID,
  resolveProjectID,
  ValidationError,
} from "./validation.ts";

const DEFAULT_OUTPUT_MAX_BYTES = 512 * 1024;
const STATUS_TIMEOUT_MS = 120_000;
const IDENTIFIER_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_ATTEMPTS = 100;
const MAX_CHANGED_LINES = 1_000_000;

export interface SddRuntimeResult {
  status: number | null;
  json: unknown;
  stderr: string;
}

export interface SddStatusArgvInput {
  binary: string;
  projectRoot: string;
}

export interface SddAttemptAcquireArgvInput {
  binary: string;
  projectRoot: string;
  change: string;
  requestId: string;
  workUnit: string;
  evidenceGoal: string;
  maxAttempts: number;
  maxChangedLines: number;
}

export interface SddAttemptAcquirePayload {
  projectRoot: string;
  change: string;
  requestId: string;
  workUnit: string;
  evidenceGoal: string;
  maxAttempts: number;
  maxChangedLines: number;
}

export interface SddRuntimeExecutorOptions {
  binary: string;
  projects: readonly ProjectConfig[];
  spawn: SpawnFn;
  outputMaxBytes?: number;
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

function assertIdentifier(value: unknown, what: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !IDENTIFIER_RE.test(value) ||
    value.includes("..") ||
    value.startsWith("-")
  ) {
    throw new ValidationError(`invalid ${what}`);
  }
  assertNoControlChars(value, what);
  assertNoShellMetachars(value, what);
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

export function buildSddStatusArgv(input: SddStatusArgvInput): string[] {
  assertRecord(input, "status input");
  assertExactKeys(input, ["binary", "projectRoot"]);
  assertBinary(input.binary);
  assertProjectRootInput(input.projectRoot);
  return [input.binary, "sdd-status", "--cwd", input.projectRoot, "--json", "--instructions"];
}

export function buildSddAttemptAcquireArgv(input: SddAttemptAcquireArgvInput): string[] {
  assertRecord(input, "attempt acquire input");
  assertExactKeys(input, [
    "binary",
    "projectRoot",
    "change",
    "requestId",
    "workUnit",
    "evidenceGoal",
    "maxAttempts",
    "maxChangedLines",
  ]);
  assertBinary(input.binary);
  assertProjectRootInput(input.projectRoot);
  assertIdentifier(input.change, "change");
  assertRequestID(input.requestId);
  if (input.requestId.startsWith("-")) {
    throw new ValidationError("request id must not start with '-'");
  }
  assertIdentifier(input.workUnit, "work unit");
  assertIdentifier(input.evidenceGoal, "evidence goal");
  assertBoundedPositiveInt(input.maxAttempts, MAX_ATTEMPTS, "maxAttempts");
  assertBoundedPositiveInt(input.maxChangedLines, MAX_CHANGED_LINES, "maxChangedLines");
  return [
    input.binary,
    "sdd-attempt",
    "acquire",
    "--cwd",
    input.projectRoot,
    "--change",
    input.change,
    "--request-id",
    input.requestId,
    "--work-unit",
    input.workUnit,
    "--evidence-goal",
    input.evidenceGoal,
    "--max-attempts",
    String(input.maxAttempts),
    "--max-changed-lines",
    String(input.maxChangedLines),
  ];
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

  async status(projectDir: unknown): Promise<SddRuntimeResult> {
    const projectRoot = this.resolveProjectRoot(projectDir);
    return this.run(buildSddStatusArgv({ binary: this.options.binary, projectRoot }), projectRoot);
  }

  async attemptAcquire(payload: SddAttemptAcquirePayload): Promise<SddRuntimeResult> {
    assertRecord(payload, "attempt acquire payload");
    assertExactKeys(payload, [
      "projectRoot",
      "change",
      "requestId",
      "workUnit",
      "evidenceGoal",
      "maxAttempts",
      "maxChangedLines",
    ]);
    const projectRoot = this.resolveProjectRoot(payload.projectRoot);
    return this.run(
      buildSddAttemptAcquireArgv({ binary: this.options.binary, ...payload, projectRoot }),
      projectRoot,
    );
  }

  private async run(argv: string[], projectRoot: string): Promise<SddRuntimeResult> {
    const result = await this.options.spawn(argv, {
      cwd: projectRoot,
      timeoutMs: STATUS_TIMEOUT_MS,
      maxOutputBytes: this.outputMaxBytes,
      env: { NO_COLOR: "1" },
    });
    if (result.timedOut) throw new SddRuntimeError("SDD runtime command timed out");
    if (result.stdout.trim().length === 0) {
      throw new SddRuntimeError("SDD runtime returned empty stdout; expected JSON");
    }
    let json: unknown;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      throw new SddRuntimeError("SDD runtime returned non-JSON stdout");
    }
    return { status: result.status, json, stderr: result.stderr };
  }
}
