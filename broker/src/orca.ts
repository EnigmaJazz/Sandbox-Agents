/**
 * Orca report bridge (S1–S6): the broker's only contact with the Orca
 * orchestration CLI.
 *
 * A sandboxed worker has no shell, so it cannot run `orca orchestration`
 * itself. This module gives it exactly one narrow path back to the coordinator
 * that dispatched it:
 *
 * - ONE fixed absolute binary. The caller never names a program, a path, an
 *   environment, or a working directory.
 * - A fixed argv vector per message type. The caller cannot choose the
 *   recipient (`--from` is the terminal handle it already holds) and cannot add
 *   a flag: a field the type's argv does not carry is REJECTED, never dropped.
 * - A read-only liveness probe runs BEFORE the send. Only a dispatch the CLI
 *   reports as live for the supplied terminal handle may be reported for; when
 *   the probe cannot be made, the report is refused (S4).
 *
 * §30: argv vectors only. No shell string is ever built here.
 */
import { existsSync } from "node:fs";
import { StateError } from "./state.ts";
import {
  assertOrcaBody,
  assertOrcaDispatchId,
  assertOrcaOptions,
  assertOrcaOutcome,
  assertOrcaPhase,
  assertOrcaSubject,
  assertOrcaTaskId,
  assertOrcaTerminal,
  assertOrcaType,
  ValidationError,
  type OrcaReportType,
} from "./validation.ts";

/** The one Orca CLI this broker will ever run. Fixed; never caller-supplied. */
export const ORCA_BINARY = "/home/james/.config/orca/linux-orca-cli-shim/orca";

/** The caller cannot raise the blocking-ask wait: the broker fixes it. */
export const ORCA_ASK_TIMEOUT_MS = 60_000;

export const ORCA_PROBE_TIMEOUT_MS = 15_000;
export const ORCA_SEND_TIMEOUT_MS = 30_000;
export const ORCA_ASK_SPAWN_TIMEOUT_MS = ORCA_ASK_TIMEOUT_MS + 30_000;

export const ORCA_PROBE_MAX_OUTPUT_BYTES = 256 * 1024;
export const ORCA_SEND_MAX_OUTPUT_BYTES = 64 * 1024;

/** S1: only run the CLI when the fixed binary actually exists (fail closed). */
export function assertOrcaAvailable(binary: string = ORCA_BINARY): void {
  if (!existsSync(binary)) {
    throw new StateError(
      `orcaReport is unavailable: the fixed Orca CLI '${binary}' does not exist on this host`,
    );
  }
}

/**
 * Read-only dispatch liveness probe (S4). Fixed argv; the caller supplies only
 * the dispatch id it already holds. `worker-show` reads the dispatch, its
 * worker and its terminal and mutates nothing.
 */
export function buildOrcaDispatchProbeArgv(binary: string, dispatchId: string): string[] {
  return [binary, "orchestration", "worker-show", "--dispatch", dispatchId, "--json"];
}

export interface OrcaReportArgvInput {
  terminal: string;
  taskId: string;
  dispatchId: string;
  type: OrcaReportType;
  subject?: unknown;
  body?: unknown;
  outcome?: unknown;
  options?: unknown;
  phase?: unknown;
}

function refuseField(field: string, type: OrcaReportType): never {
  throw new ValidationError(`orcaReport type '${type}' does not accept '${field}'`);
}

/**
 * Build the exact send argv for one message type. Every field is validated here
 * (S3) and a field the type cannot carry is refused (S2), so a caller can never
 * turn a value into a flag, reach another recipient, or smuggle an extra flag.
 */
export function buildOrcaReportArgv(binary: string, input: OrcaReportArgvInput): string[] {
  assertOrcaTerminal(input.terminal);
  assertOrcaTaskId(input.taskId);
  assertOrcaDispatchId(input.dispatchId);
  const type = input.type;
  assertOrcaType(type);
  switch (type) {
    case "worker_done": {
      if (input.phase !== undefined) refuseField("phase", type);
      if (input.options !== undefined) refuseField("options", type);
      const subject = input.subject;
      const body = input.body;
      const outcome = input.outcome;
      assertOrcaSubject(subject);
      assertOrcaBody(body);
      assertOrcaOutcome(outcome);
      return [
        binary,
        "orchestration",
        "send",
        "--from",
        input.terminal,
        "--type",
        "worker_done",
        "--subject",
        subject,
        "--body",
        body,
        "--outcome",
        outcome,
        "--task-id",
        input.taskId,
        "--dispatch-id",
        input.dispatchId,
      ];
    }
    case "heartbeat": {
      if (input.outcome !== undefined) refuseField("outcome", type);
      if (input.options !== undefined) refuseField("options", type);
      if (input.body !== undefined) refuseField("body", type);
      const subject = input.subject;
      const phase = input.phase;
      assertOrcaSubject(subject);
      assertOrcaPhase(phase);
      return [
        binary,
        "orchestration",
        "send",
        "--from",
        input.terminal,
        "--type",
        "heartbeat",
        "--subject",
        subject,
        "--phase",
        phase,
        "--task-id",
        input.taskId,
        "--dispatch-id",
        input.dispatchId,
      ];
    }
    case "ask": {
      if (input.subject !== undefined) refuseField("subject", type);
      if (input.outcome !== undefined) refuseField("outcome", type);
      if (input.phase !== undefined) refuseField("phase", type);
      const question = input.body;
      assertOrcaBody(question);
      const options = assertOrcaOptions(input.options);
      return [
        binary,
        "orchestration",
        "ask",
        "--from",
        input.terminal,
        "--question",
        question,
        "--timeout-ms",
        String(ORCA_ASK_TIMEOUT_MS),
        ...(options.length > 0 ? ["--options", options.join(",")] : []),
      ];
    }
    default: {
      // Exhaustive over OrcaReportType; assertOrcaType already refused anything else.
      const unreachable: never = type;
      throw new ValidationError(`unsupported orcaReport type '${String(unreachable)}'`);
    }
  }
}

export interface OrcaExpectedDispatch {
  terminal: string;
  taskId: string;
  dispatchId: string;
}

/** Settlement fields a live dispatch must still carry, all present and null. */
const DISPATCH_SETTLEMENT_FIELDS = [
  "completedAt",
  "terminationReason",
  "capabilityRevokedAt",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read one dispatch out of the `worker-show` probe reply (S4).
 *
 * Verified contract (installed Orca CLI, `orchestration worker-show --dispatch
 * <ctx_…> --json`):
 *
 *   { "ok": true,
 *     "result": { "dispatch": { "id": "ctx_…", "taskId": "task_…",
 *       "assigneeHandle": "term_…", "status": "dispatched",
 *       "completedAt": null, "terminationReason": null,
 *       "capabilityRevokedAt": null, … },
 *       "worker": …, "terminal": …, … } }
 *
 * A dispatch is accepted only when `ok` is true, `result.dispatch` is a plain
 * object naming the expected dispatch id, task id and terminal handle, its
 * status is exactly "dispatched", and all three settlement fields are present
 * and null. Everything else throws StateError naming the reason, so a report is
 * refused rather than sent on a guess.
 */
export function parseOrcaDispatchProbe(
  stdout: string,
  expected: OrcaExpectedDispatch,
): { status: "dispatched" } {
  let reply: unknown;
  try {
    reply = JSON.parse(stdout);
  } catch {
    throw new StateError("orcaReport refused: the dispatch liveness probe did not return JSON");
  }
  if (!isRecord(reply)) {
    throw new StateError(
      "orcaReport refused: the dispatch liveness probe did not return a JSON object",
    );
  }
  if (reply.ok !== true) {
    throw new StateError(
      "orcaReport refused: the dispatch liveness probe did not succeed (ok is not true)",
    );
  }
  const result = reply.result;
  if (!isRecord(result)) {
    throw new StateError(
      "orcaReport refused: the dispatch liveness probe returned no result object",
    );
  }
  const dispatch = result.dispatch;
  if (!isRecord(dispatch)) {
    throw new StateError(
      "orcaReport refused: the dispatch liveness probe returned no dispatch object",
    );
  }
  if (dispatch.id !== expected.dispatchId) {
    throw new StateError(
      `orcaReport refused: the dispatch liveness probe reported dispatch ${String(dispatch.id)} instead of ${expected.dispatchId}`,
    );
  }
  if (dispatch.taskId !== expected.taskId) {
    throw new StateError(
      `orcaReport refused: the dispatch liveness probe reported task ${String(dispatch.taskId)} instead of ${expected.taskId}`,
    );
  }
  if (dispatch.assigneeHandle !== expected.terminal) {
    throw new StateError(
      `orcaReport refused: the dispatch liveness probe reported assignee ${String(dispatch.assigneeHandle)} instead of terminal ${expected.terminal}`,
    );
  }
  if (dispatch.status === undefined) {
    throw new StateError(
      "orcaReport refused: the dispatch liveness probe did not report a status",
    );
  }
  if (dispatch.status !== "dispatched") {
    throw new StateError(
      `orcaReport refused: dispatch ${expected.dispatchId} is not live (status ${String(dispatch.status)})`,
    );
  }
  for (const field of DISPATCH_SETTLEMENT_FIELDS) {
    if (!(field in dispatch)) {
      throw new StateError(
        `orcaReport refused: the dispatch liveness probe did not report ${field}`,
      );
    }
    if (dispatch[field] !== null) {
      throw new StateError(
        `orcaReport refused: dispatch ${expected.dispatchId} is not live (${field} is ${JSON.stringify(dispatch[field])})`,
      );
    }
  }
  return { status: "dispatched" };
}
