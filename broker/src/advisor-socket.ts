/**
 * External advisor socket (odd/tasks/external-advisors.md A1;
 * docs/advisor/interface-contract.md).
 *
 * One extra Unix listener per configured project. The broker, not the request,
 * decides who an advisor connection is: at open it binds the connection to one
 * fresh session `advisor-<projectId>-<random>`, and every request on it is
 * rewritten to that session and the fixed `external-advisor` agent. The
 * project is fixed by the listener. Only worker operations are reachable:
 * nothing that exports, applies, installs, commits, binds agents, or calls
 * gentle-ai. The main socket refuses advisor sessions, so neither side can
 * operate the other's work.
 */
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { PolicyError } from "./policy.ts";
import type { BrokerRequestEnvelope } from "./types.ts";
import { ValidationError } from "./validation.ts";

export const ADVISOR_AGENT = "external-advisor";

/** The literal sessionID an advisor client sends before it learns its assignment. */
export const ADVISOR_SESSION_PLACEHOLDER = "advisor";

const ADVISOR_SESSION_PREFIX = "advisor";
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Worker-only operations; everything else is refused on the advisor socket. */
export const ADVISOR_ALLOWED_OPERATIONS: ReadonlySet<string> = new Set([
  "ensureWorker",
  "workerStatus",
  "destroyWorker",
  "exec",
  "readFile",
  "writeFile",
  "applyPatch",
  "listDir",
  "grep",
  "diff",
  "resultDiff",
  // A3a: read one advisory request (claims it), answer it once.
  "advisorRead",
  "advisorRespond",
  "evidenceKeep",
]);

/** Operations that exist only for advisor connections; the main socket refuses them. */
export const ADVISOR_ONLY_OPERATIONS: ReadonlySet<string> = new Set(["advisorRead", "advisorRespond", "evidenceKeep"]);

export interface AdvisorBinding {
  projectId: string;
  projectPath: string;
  sessionID: string;
}

function assertProjectId(projectId: string): void {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new ValidationError(`advisor project id must match ${PROJECT_ID_RE}, got ${JSON.stringify(projectId)}`);
  }
}

/** `<dir of main socket>/opencode-sandbox-advisor-<projectId>.sock` */
export function advisorSocketPath(mainSocketPath: string, projectId: string): string {
  assertProjectId(projectId);
  return join(dirname(mainSocketPath), `opencode-sandbox-advisor-${projectId}.sock`);
}

/** A fresh session id; at most 7 + 1 + 32 + 1 + 16 = 57 chars, inside SESSION_ID_RE. */
export function newAdvisorSessionID(projectId: string): string {
  assertProjectId(projectId);
  return `${ADVISOR_SESSION_PREFIX}-${projectId}-${randomBytes(8).toString("hex")}`;
}

function isAdvisorSessionID(sessionID: string): boolean {
  return sessionID === ADVISOR_SESSION_PLACEHOLDER || sessionID.startsWith(`${ADVISOR_SESSION_PREFIX}-`);
}

/** Rewrite a request from an advisor connection, or refuse it. */
export function bindAdvisorRequest(req: BrokerRequestEnvelope, binding: AdvisorBinding): BrokerRequestEnvelope {
  if (!ADVISOR_ALLOWED_OPERATIONS.has(req.operation)) {
    throw new PolicyError(`operation '${req.operation}' is not available on the advisor socket`);
  }
  if (req.sessionID !== ADVISOR_SESSION_PLACEHOLDER && req.sessionID !== binding.sessionID) {
    throw new PolicyError("an advisor connection operates only its own session");
  }
  let payload = req.payload;
  if (req.operation === "ensureWorker") {
    const given = (payload as { projectDir?: unknown } | undefined)?.projectDir;
    if (given !== undefined && given !== binding.projectPath) {
      throw new PolicyError(`the advisor socket is pinned to project '${binding.projectId}'`);
    }
    payload = { ...((payload as Record<string, unknown> | undefined) ?? {}), projectDir: binding.projectPath };
  }
  return {
    ...req,
    sessionID: binding.sessionID,
    agent: ADVISOR_AGENT,
    ...(payload !== undefined ? { payload } : {}),
  };
}

/** The main socket never operates an advisor session. */
export function refuseAdvisorSessionOnMain(req: BrokerRequestEnvelope): BrokerRequestEnvelope {
  if (ADVISOR_ONLY_OPERATIONS.has(req.operation)) {
    throw new PolicyError(`operation '${req.operation}' is available only on an advisor socket`);
  }
  if (isAdvisorSessionID(req.sessionID)) {
    throw new PolicyError("advisor sessions are reachable only through their advisor socket");
  }
  return req;
}
