/**
 * Advisory request records (odd/tasks/external-advisors.md A3a;
 * docs/advisor/interface-contract.md §3, §5–§6).
 *
 * Records are EVIDENCE, never authority: nothing here issues a key, writes a
 * routing marker, approves anything, or calls gentle-ai. A record is three
 * files under <stateDir>/advisor/<projectId>/requests/:
 *
 *   <id>.json           the request, published once, never rewritten
 *   <id>.claim          the advisor session that claimed it
 *   <id>.response.json  that advisor's single response
 *
 * Each is published by an exclusive hard link from a private temp file, so a
 * second claim or response fails at the OS level even under a race: records
 * are immutable by construction, not by a check. Status is derived from which
 * files exist and the clock: pending → claimed → submitted | declined, or
 * expired when unanswered past its TTL.
 *
 * Main socket: advisorAsk (orchestrator-only mutation), advisorGet and
 * advisorList (reads). Advisor socket: advisorRead and advisorRespond, whose
 * project is taken from the broker-assigned advisor session id.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isExternalLensLineage } from "./advisor-lineages.ts";
import { validateReviewerResult } from "./advisor-reviewer-result.ts";
import { PolicyError } from "./policy.ts";
import type { SddRuntimeExecutor } from "./sdd-runtime.ts";
import { authorizeHostDispatch, type OpContext } from "./service.ts";
import type { BrokerRequestEnvelope } from "./types.ts";
import { ValidationError, assertPayloadKeys, resolveProjectID } from "./validation.ts";

export const ADVISOR_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

const HOSTS = ["claude", "agy"] as const;
type Host = (typeof HOSTS)[number];
type RequestedHost = Host | "rotate";
type Kind = "pre-code-advice" | "review-lens";
type Status = "pending" | "claimed" | "submitted" | "declined" | "expired";

const ID_RE = /^adv-[0-9a-f]{16}$/;
const TASK_RE = /^odd\/tasks\/[A-Za-z0-9._-]{1,128}\.md#[A-Za-z0-9._-]{1,32}$/;
const TOKEN_RE = /^[a-z0-9-]{1,64}$/;
const SLUG_RE = /^[A-Za-z0-9._-]{1,64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const RESULT_REF_RE = /^refs\/opencode-sandbox\/result\/[A-Za-z0-9_-]{1,64}$/;
const ADVISOR_SESSION_RE = /^advisor-([A-Za-z0-9_-]{1,32})-[0-9a-f]{16}$/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_FINDINGS_BYTES = 256 * 1024;
const MAX_EVIDENCE_REFS = 32;
const MAX_LENS_CONTEXT_BYTES = 1024 * 1024;
const REVIEW_LENSES = ["review-risk", "review-resilience", "review-readability", "review-reliability"] as const;

/** Advisory operations that reach gentle-ai (review-lens asks) need its runtime. */
type AdvisorContext = OpContext & { sddRuntime?: Pick<SddRuntimeExecutor, "reviewStatus" | "reviewLensContext"> };

interface StoredReview {
  lineage: string;
  lens: string;
  /** Provider values read by the broker from gentle-ai, never from the caller. */
  target: string;
  order: number;
  subjectHash: string;
  lensContext: string;
}

interface StoredRequest {
  schema: "advisor-request/v1";
  id: string;
  projectId: string;
  kind: Kind;
  binding: { task: string; step: string; route?: string; stage?: string };
  snapshot: { resultRef: string } | { commit: string } | { worktree: true };
  selection: { rule: string; requestedHost: RequestedHost; resolvedHost: Host };
  group: string | null;
  thread: string;
  parentId: string | null;
  question: string | null;
  evidenceRefs: string[];
  review: StoredReview | null;
  askedBy: string;
  createdAt: number;
  expiresAt: number;
}

interface StoredClaim {
  session: string;
  claimedAt: number;
}

interface StoredResponse {
  status: "submitted" | "declined";
  verdict: string | null;
  findings: unknown[];
  /** review-lens only: the reviewer result exactly as submitted, relayed byte-for-byte by A4. */
  reviewerResult?: unknown;
  session: string;
  respondedAt: number;
}

type Payload = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function payloadOf(req: BrokerRequestEnvelope): Payload {
  assertPayloadKeys(req.operation, req.payload);
  return (req.payload ?? {}) as Payload;
}

function text(value: unknown, what: string, required: boolean, maxBytes = MAX_TEXT_BYTES): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new ValidationError(`${what} must be a non-empty string`);
  if (Buffer.byteLength(value) > maxBytes) throw new ValidationError(`${what} exceeds ${maxBytes} bytes`);
  if (CONTROL_RE.test(value)) throw new ValidationError(`${what} contains control characters`);
  return value;
}

function matching(value: unknown, re: RegExp, what: string): string {
  if (typeof value !== "string" || !re.test(value)) throw new ValidationError(`${what} must match ${re}`);
  return value;
}

function exactKeys(value: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(`${what} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ValidationError(`${what} has unexpected field '${key}'`);
  }
  return value as Record<string, unknown>;
}

function validBinding(value: unknown): StoredRequest["binding"] {
  const b = exactKeys(value, ["task", "step", "route", "stage"], "binding");
  return {
    task: matching(b.task, TASK_RE, "binding.task"),
    step: text(b.step, "binding.step", true, 128)!,
    ...(b.route !== undefined ? { route: matching(b.route, SLUG_RE, "binding.route") } : {}),
    ...(b.stage !== undefined ? { stage: matching(b.stage, SLUG_RE, "binding.stage") } : {}),
  };
}

function validSnapshot(value: unknown): StoredRequest["snapshot"] {
  const s = exactKeys(value, ["resultRef", "commit", "worktree"], "snapshot");
  const keys = Object.keys(s);
  if (keys.length !== 1) throw new ValidationError("snapshot must name exactly one of resultRef, commit, worktree");
  if (keys[0] === "resultRef") return { resultRef: matching(s.resultRef, RESULT_REF_RE, "snapshot.resultRef") };
  if (keys[0] === "commit") return { commit: matching(s.commit, COMMIT_RE, "snapshot.commit") };
  if (s.worktree !== true) throw new ValidationError("snapshot.worktree must be true");
  return { worktree: true };
}

function validEvidenceRefs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_REFS) {
    throw new ValidationError(`evidenceRefs must be an array of at most ${MAX_EVIDENCE_REFS} strings`);
  }
  return value.map((v, i) => text(v, `evidenceRefs[${i}]`, true, 4096)!);
}

function validFindings(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError("findings must be an array");
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_FINDINGS_BYTES) {
    throw new ValidationError(`findings exceed ${MAX_FINDINGS_BYTES} bytes`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function requestsDir(ctx: OpContext, projectId: string): string {
  const advisorRoot = privateDir(join(ctx.config.stateDir, "advisor"));
  const projectRoot = privateDir(join(advisorRoot, projectId));
  return privateDir(join(projectRoot, "requests"));
}

/** Publish `name` exactly once: false when it already exists. */
function publishExclusive(dir: string, name: string, data: unknown): boolean {
  const tmp = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  try {
    linkSync(tmp, join(dir, name));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    unlinkSync(tmp);
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function loadRequest(dir: string, id: string): StoredRequest {
  const request = readJson<StoredRequest>(join(dir, `${id}.json`));
  if (!request) throw new ValidationError("advisory request not found");
  return request;
}

function statusOf(request: StoredRequest, claim: StoredClaim | undefined, response: StoredResponse | undefined, now: number): Status {
  if (response) return response.status;
  if (now > request.expiresAt) return "expired";
  return claim ? "claimed" : "pending";
}

/**
 * Least recently used host for the project.
 *
 * INVARIANT (review finding R3-rotate-race): the read of rotation.json and its
 * replacement must stay in ONE synchronous stretch, with no `await` and no
 * async fs call between them. The broker is a single process on a
 * single-threaded runtime, so a synchronous read-modify-write cannot
 * interleave with another ask. Callers may await before or after this
 * function, never inside it. The test "concurrent rotate asks never resolve
 * to the same host twice in a row" fails if this stretch is ever split.
 */
function rotateHost(dir: string): Host {
  const path = join(dir, "..", "rotation.json");
  const last = readJson<{ last?: Host }>(path)?.last;
  const next: Host = last === "claude" ? "agy" : "claude";
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ last: next })}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return next;
}

function advisorProject(sessionID: string, operation: string): string {
  const m = ADVISOR_SESSION_RE.exec(sessionID);
  if (!m) throw new PolicyError(`${operation} is available only to advisor sessions`);
  return m[1]!;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

type Clock = () => number;

/**
 * Read the provider values for one lens of an external-lens lineage from
 * gentle-ai: the current `collect` input for that lens (target, order,
 * subject hash) and its reviewer task (`review lens-context`). The caller
 * supplies only lineage and lens; everything else comes from the provider.
 */
async function providerReview(ctx: AdvisorContext, projectId: string, projectDir: string, value: unknown): Promise<StoredReview> {
  const r = exactKeys(value, ["lineage", "lens"], "review");
  const lens = r.lens;
  if (typeof lens !== "string" || !(REVIEW_LENSES as readonly string[]).includes(lens)) {
    throw new ValidationError(`review.lens must be one of ${REVIEW_LENSES.join(", ")}`);
  }
  const lineage = r.lineage as string;
  if (!isExternalLensLineage(ctx, projectId, lineage)) {
    throw new PolicyError(`lineage ${lineage} is not an external-lens lineage (start it with externalLenses)`);
  }
  if (!ctx.sddRuntime) throw new PolicyError("review-lens requests need the gentle-ai runtime");
  const status = await ctx.sddRuntime.reviewStatus({ projectDir, lineage });
  if (status.status !== 0 || !status.json || typeof status.json !== "object") {
    throw new PolicyError(`gentle-ai review status failed (exit ${String(status.status)}): ${status.stderr.slice(0, 300)}`);
  }
  const transition = (status.json as { next_transition?: { kind?: string; collect?: { inputs?: unknown[] } } }).next_transition;
  const inputs = transition?.kind === "collect" ? (transition.collect?.inputs ?? []) : [];
  const args = inputs
    .map((input) => (input as { arguments?: Array<{ name: string; value: string }> }).arguments ?? [])
    .map((list) => Object.fromEntries(list.map((a) => [a.name, a.value])) as Record<string, string>)
    .find((a) => a.lens === lens);
  if (!args) throw new PolicyError(`lineage ${lineage} is not collecting a result for ${lens}`);
  const order = Number(args.order);
  if (!args.target || !args["subject-hash"] || !args["expected-revision"] || !args["repository-context"] || !Number.isInteger(order)) {
    throw new PolicyError("gentle-ai collect input is missing provider values");
  }
  const context = await ctx.sddRuntime.reviewLensContext({
    projectDir,
    repositoryContext: args["repository-context"],
    lineage,
    target: args.target,
    expectedRevision: args["expected-revision"],
    lens,
  });
  if (context.status !== 0 || typeof context.text !== "string" || context.text.length === 0) {
    throw new PolicyError(`gentle-ai review lens-context failed (exit ${String(context.status)})`);
  }
  if (Buffer.byteLength(context.text) > MAX_LENS_CONTEXT_BYTES) throw new PolicyError("lens-context exceeds 1 MiB");
  const bindingLine = context.text.split("\n").find((line) => line.startsWith("GENTLE_AI_REVIEW_BINDING "));
  let bound: { subject_hash?: string } | undefined;
  try {
    bound = bindingLine ? JSON.parse(bindingLine.slice("GENTLE_AI_REVIEW_BINDING ".length)) : undefined;
  } catch {
    bound = undefined;
  }
  if (bound?.subject_hash !== args["subject-hash"]) {
    throw new PolicyError("lens-context binding disagrees with the provider's subject hash");
  }
  return { lineage, lens, target: args.target, order, subjectHash: args["subject-hash"], lensContext: context.text };
}

export function buildAdvisorAskOp(ctx: AdvisorContext, now: Clock = Date.now) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const p = payloadOf(req);
    authorizeHostDispatch(ctx, "advisorAsk", req.sessionID, req.agent);
    const projectId = resolveProjectID(p.projectDir, ctx.config.projects);
    const kind = p.kind;
    if (kind !== "pre-code-advice" && kind !== "review-lens") {
      throw new ValidationError("kind must be pre-code-advice or review-lens");
    }
    if (kind === "pre-code-advice" && p.review !== undefined) {
      throw new ValidationError("review is only valid for review-lens requests");
    }
    const binding = validBinding(p.binding);
    const snapshot = validSnapshot(p.snapshot);
    const host = p.host;
    if (host !== "claude" && host !== "agy" && host !== "rotate") {
      throw new ValidationError("host must be claude, agy or rotate");
    }
    const selection = exactKeys(p.selection, ["rule"], "selection");
    const rule = matching(selection.rule, TOKEN_RE, "selection.rule");
    const group = p.group === undefined ? null : matching(p.group, TOKEN_RE, "group");
    const question = text(p.question, "question", kind === "pre-code-advice") ?? null;
    const evidenceRefs = validEvidenceRefs(p.evidenceRefs);
    const review = kind === "review-lens" ? await providerReview(ctx, projectId, p.projectDir as string, p.review) : null;
    const dir = requestsDir(ctx, projectId);
    let thread: string | undefined;
    let parentId: string | null = null;
    if (p.parentId !== undefined) {
      parentId = matching(p.parentId, ID_RE, "parentId");
      const parent = readJson<StoredRequest>(join(dir, `${parentId}.json`));
      if (!parent) throw new ValidationError("parentId names no request in this project (the parent must exist)");
      thread = parent.thread;
    }
    const id = `adv-${randomBytes(8).toString("hex")}`;
    const created = now();
    const record: StoredRequest = {
      schema: "advisor-request/v1",
      id,
      projectId,
      kind,
      binding,
      snapshot,
      selection: { rule, requestedHost: host, resolvedHost: host === "rotate" ? rotateHost(dir) : host },
      group,
      thread: thread ?? id,
      parentId,
      question,
      evidenceRefs,
      review,
      askedBy: req.sessionID,
      createdAt: created,
      expiresAt: created + ADVISOR_REQUEST_TTL_MS,
    };
    if (!publishExclusive(dir, `${id}.json`, record)) throw new Error("advisory request id collision");
    return { id, thread: record.thread, status: "pending" };
  };
}

function view(dir: string, request: StoredRequest, now: number) {
  const claim = readJson<StoredClaim>(join(dir, `${request.id}.claim`));
  const response = readJson<StoredResponse>(join(dir, `${request.id}.response.json`));
  return {
    id: request.id,
    kind: request.kind,
    binding: request.binding,
    thread: request.thread,
    parentId: request.parentId,
    group: request.group,
    status: statusOf(request, claim, response, now),
    snapshot: request.snapshot,
    selection: { ...request.selection, override: null },
    question: request.question,
    evidenceRefs: request.evidenceRefs,
    ...(request.review
      ? {
          review: {
            lineage: request.review.lineage,
            lens: request.review.lens,
            target: request.review.target,
            order: request.review.order,
            subjectHash: request.review.subjectHash,
            lensContextBytes: Buffer.byteLength(request.review.lensContext),
          },
        }
      : {}),
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    ...(claim ? { advisor: { session: claim.session } } : {}),
    ...(response
      ? {
          response: {
            verdict: response.verdict,
            findings: response.findings,
            ...(response.reviewerResult !== undefined ? { reviewerResult: response.reviewerResult } : {}),
            respondedAt: response.respondedAt,
          },
        }
      : {}),
  };
}

export function buildAdvisorGetOp(ctx: OpContext, now: Clock = Date.now) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const p = payloadOf(req);
    authorizeHostDispatch(ctx, "advisorGet", req.sessionID, req.agent);
    const dir = requestsDir(ctx, resolveProjectID(p.projectDir, ctx.config.projects));
    return view(dir, loadRequest(dir, matching(p.id, ID_RE, "id")), now());
  };
}

export function buildAdvisorListOp(ctx: OpContext, now: Clock = Date.now) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const p = payloadOf(req);
    authorizeHostDispatch(ctx, "advisorList", req.sessionID, req.agent);
    const dir = requestsDir(ctx, resolveProjectID(p.projectDir, ctx.config.projects));
    const task = p.task === undefined ? undefined : matching(p.task, TASK_RE, "task");
    const step = p.step === undefined ? undefined : text(p.step, "step", true, 128);
    const status = p.status === undefined ? undefined : matching(p.status, /^(pending|claimed|submitted|declined|expired)$/, "status");
    const at = now();
    return readdirSync(dir)
      .filter((name) => /^adv-[0-9a-f]{16}\.json$/.test(name))
      .map((name) => view(dir, loadRequest(dir, name.slice(0, -5)), at))
      .filter((r) => (task === undefined || r.binding.task === task) && (step === undefined || r.binding.step === step))
      .filter((r) => status === undefined || r.status === status)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        binding: r.binding,
        status: r.status,
        thread: r.thread,
        group: r.group,
        resolvedHost: r.selection.resolvedHost,
        createdAt: r.createdAt,
      }));
  };
}

export function buildAdvisorReadOp(ctx: OpContext, now: Clock = Date.now) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const p = payloadOf(req);
    const projectId = advisorProject(req.sessionID, "advisorRead");
    const dir = requestsDir(ctx, projectId);
    const id = matching(p.id, ID_RE, "id");
    const request = loadRequest(dir, id);
    const at = now();
    const response = readJson<StoredResponse>(join(dir, `${id}.response.json`));
    if (!response && at > request.expiresAt) throw new PolicyError("advisory request has expired");
    let claim = readJson<StoredClaim>(join(dir, `${id}.claim`));
    if (!claim) {
      publishExclusive(dir, `${id}.claim`, { session: req.sessionID, claimedAt: at } satisfies StoredClaim);
      claim = readJson<StoredClaim>(join(dir, `${id}.claim`));
    }
    if (claim?.session !== req.sessionID) throw new PolicyError("advisory request is claimed by another advisor");
    // The advisor sees its own request only: never a response, never another record.
    return {
      id: request.id,
      kind: request.kind,
      binding: request.binding,
      thread: request.thread,
      parentId: request.parentId,
      snapshot: request.snapshot,
      resolvedHost: request.selection.resolvedHost,
      question: request.question,
      evidenceRefs: request.evidenceRefs,
      ...(request.review
        ? {
            review: {
              lineage: request.review.lineage,
              lens: request.review.lens,
              target: request.review.target,
              order: request.review.order,
              subjectHash: request.review.subjectHash,
              lensContext: request.review.lensContext,
            },
          }
        : {}),
      status: statusOf(request, claim, response, at),
    };
  };
}

export function buildAdvisorRespondOp(ctx: OpContext, now: Clock = Date.now) {
  return async (req: BrokerRequestEnvelope): Promise<unknown> => {
    const p = payloadOf(req);
    const projectId = advisorProject(req.sessionID, "advisorRespond");
    const dir = requestsDir(ctx, projectId);
    const id = matching(p.id, ID_RE, "id");
    const request = loadRequest(dir, id);
    const status = p.status;
    if (status !== "submitted" && status !== "declined") throw new ValidationError("status must be submitted or declined");
    let verdict: string | null;
    let reviewerResult: unknown;
    if (request.kind === "review-lens") {
      if (status === "submitted") {
        if (p.reviewerResult === undefined) throw new ValidationError("a submitted review-lens response needs reviewerResult");
        validateReviewerResult(p.reviewerResult, { subjectHash: request.review!.subjectHash, lens: request.review!.lens });
        reviewerResult = p.reviewerResult;
        verdict = text(p.verdict, "verdict", false) ?? null;
      } else {
        if (p.reviewerResult !== undefined) throw new ValidationError("a declined response carries no reviewerResult");
        verdict = text(p.verdict, "verdict", true)!;
      }
    } else {
      if (p.reviewerResult !== undefined) throw new ValidationError("reviewerResult is only valid for review-lens requests");
      verdict = text(p.verdict, "verdict", true)!;
    }
    const findings = validFindings(p.findings);
    const at = now();
    if (existsSync(join(dir, `${id}.response.json`))) throw new PolicyError("advisory request was already answered");
    if (at > request.expiresAt) throw new PolicyError("advisory request has expired");
    const claim = readJson<StoredClaim>(join(dir, `${id}.claim`));
    if (!claim) throw new PolicyError("advisory request is not claimed; read it first");
    if (claim.session !== req.sessionID) throw new PolicyError("advisory request is claimed by another advisor");
    const stored: StoredResponse = {
      status,
      verdict,
      findings,
      ...(reviewerResult !== undefined ? { reviewerResult } : {}),
      session: req.sessionID,
      respondedAt: at,
    };
    if (!publishExclusive(dir, `${id}.response.json`, stored)) {
      throw new PolicyError("advisory request was already answered");
    }
    return { id, status };
  };
}
