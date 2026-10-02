/**
 * External advisors A3b (odd/tasks/external-advisors.md): review-lens advisory
 * requests. The broker, never the model, reads the provider values (target,
 * order, subject hash) and the reviewer task (lens-context) from gentle-ai for
 * an external-lens lineage, and pre-checks a reviewer result before storing it.
 * gentle-ai's own preflight at relay time (A4) stays authoritative.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExternalLensLineage, markExternalLensLineage } from "../src/advisor-lineages.ts";
import {
  buildAdvisorAskOp,
  buildAdvisorGetOp,
  buildAdvisorReadOp,
  buildAdvisorRespondOp,
} from "../src/advisor-records.ts";
import { defaultConfig } from "../src/config.ts";
import type { OpContext } from "../src/service.ts";
import type { BrokerRequestEnvelope } from "../src/types.ts";
import { ValidationError } from "../src/validation.ts";

const ORCH = "gentle-orchestrator";
const ORCH_SESSION = "ses_orchestrator";
const ADVISOR = "advisor-repo-aaaaaaaaaaaaaaaa";
const LINEAGE = "review-d6d1312c5655c0de";
const SUBJECT = `sha256:${"a".repeat(64)}`;
const TARGET = `sha256:${"b".repeat(64)}`;
const REVISION = `sha256:${"c".repeat(64)}`;

function collectStatus(lens = "review-reliability", order = "0") {
  return {
    status: 0,
    stderr: "",
    json: {
      next_transition: {
        kind: "collect",
        reason_code: "reviewer_results_required",
        collect: {
          inputs: [
            {
              name: "reviewer_result",
              capture_operation: "review.capture-result",
              arguments: [
                { name: "lineage", value: LINEAGE },
                { name: "expected-revision", value: REVISION },
                { name: "target", value: TARGET },
                { name: "repository-context", value: "rctx2_abc" },
                { name: "lens", value: lens },
                { name: "order", value: order },
                { name: "subject-hash", value: SUBJECT },
              ],
              artifact_subject: { schema: "gentle-ai.review-artifact-subject/v2", subject_hash: SUBJECT },
            },
          ],
        },
      },
    },
  };
}

const lensContextText = (subject = SUBJECT) =>
  [
    `GENTLE_AI_REVIEW_BINDING ${JSON.stringify({ lineage: LINEAGE, target: TARGET, lens: "review-reliability", order: 0, revision: REVISION, repository_context: "rctx2_abc", subject_hash: subject })}`,
    "GENTLE_AI_REVIEW_INSTRUCTION",
    "Review the candidate for reliability.",
    "GENTLE_AI_REVIEW_INSTRUCTION_END",
  ].join("\n");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(runtime: { status?: unknown; lensContext?: unknown } = {}) {
  const root = mkdtempSync(join(tmpdir(), "advisor-review-lens-"));
  roots.push(root);
  const projectPath = join(root, "repo");
  mkdirSync(projectPath);
  const config = defaultConfig({
    stateDir: join(root, "state"),
    projects: [{ id: "repo", path: projectPath }],
    readOnlyAgents: [ORCH],
  });
  const calls: string[] = [];
  const ctx = {
    config,
    store: {
      get: (id: string) =>
        id === ORCH_SESSION ? { sessionID: id, state: "HOST_READ_ONLY", agent: ORCH, createdAt: "", updatedAt: "" } : undefined,
    },
    sddRuntime: {
      reviewStatus: async (p: { lineage?: string }) => {
        calls.push(`status:${p.lineage}`);
        return runtime.status ?? collectStatus();
      },
      reviewLensContext: async () => {
        calls.push("lens-context");
        return runtime.lensContext ?? { status: 0, text: lensContextText(), stderr: "" };
      },
    },
  } as unknown as OpContext;
  const call = async (op: string, sessionID: string, payload?: Record<string, unknown>) => {
    const req = { version: 1, id: "r", operation: op, sessionID, payload } as BrokerRequestEnvelope;
    const b: Record<string, (c: OpContext) => (r: BrokerRequestEnvelope) => Promise<unknown>> = {
      advisorAsk: buildAdvisorAskOp,
      advisorGet: buildAdvisorGetOp,
      advisorRead: buildAdvisorReadOp,
      advisorRespond: buildAdvisorRespondOp,
    };
    return (await b[op]!(ctx)(req)) as any;
  };
  return { ctx, call, calls, projectPath };
}

const lensAsk = (projectDir: string, extra: Record<string, unknown> = {}) => ({
  projectDir,
  kind: "review-lens",
  binding: { task: "odd/tasks/feature-x.md#T3", step: "slice-1 review" },
  snapshot: { commit: "d".repeat(40) },
  host: "rotate",
  selection: { rule: "review-lens-external" },
  review: { lineage: LINEAGE, lens: "review-reliability" },
  ...extra,
});

function validResult(overrides: Record<string, unknown> = {}) {
  return {
    subject_hash: SUBJECT,
    inspection: { status: "completed", paths: ["a.ts"] },
    findings: [
      {
        id: "R3-divide-by-zero",
        lens: "review-reliability",
        severity: "CRITICAL",
        location: "a.ts:2",
        claim: "f() divides by zero for every input.",
        evidence_class: "deterministic",
        causal_disposition: "introduced",
        proof_refs: ["diagnostic /work/.advisor/f.ts printed Infinity for f(1)"],
      },
    ],
    evidence: ["inspected a.ts in full and ran a diagnostic in an isolated worker"],
    ...overrides,
  };
}

async function askedAndClaimed(projectPath: string, call: ReturnType<typeof setup>["call"], ctx: OpContext) {
  markExternalLensLineage(ctx, "repo", LINEAGE);
  const { id } = await call("advisorAsk", ORCH_SESSION, lensAsk(projectPath));
  await call("advisorRead", ADVISOR, { id });
  return id as string;
}

describe("external-lens lineage registry", () => {
  test("marking is idempotent and per project; malformed lineages are refused", () => {
    const { ctx } = setup();
    expect(isExternalLensLineage(ctx, "repo", LINEAGE)).toBe(false);
    markExternalLensLineage(ctx, "repo", LINEAGE);
    markExternalLensLineage(ctx, "repo", LINEAGE);
    expect(isExternalLensLineage(ctx, "repo", LINEAGE)).toBe(true);
    expect(() => markExternalLensLineage(ctx, "repo", "../x")).toThrow(ValidationError);
    expect(() => isExternalLensLineage(ctx, "repo", "nope")).toThrow(ValidationError);
  });
});

describe("asking for a review lens", () => {
  test("the broker reads provider values and the reviewer task from gentle-ai, never from the caller", async () => {
    const { ctx, call, calls, projectPath } = setup();
    markExternalLensLineage(ctx, "repo", LINEAGE);
    const { id } = await call("advisorAsk", ORCH_SESSION, lensAsk(projectPath));
    expect(calls).toEqual([`status:${LINEAGE}`, "lens-context"]);
    const got = await call("advisorGet", ORCH_SESSION, { projectDir: projectPath, id });
    expect(got.review).toMatchObject({ lineage: LINEAGE, lens: "review-reliability", target: TARGET, order: 0, subjectHash: SUBJECT });
    const read = await call("advisorRead", ADVISOR, { id });
    expect(read.review.lensContext).toContain("Review the candidate for reliability.");
    expect(read.review).toMatchObject({ lineage: LINEAGE, lens: "review-reliability", subjectHash: SUBJECT });
  });

  test("a lineage not started for external advisors is refused before gentle-ai is called", async () => {
    const { call, calls, projectPath } = setup();
    await expect(call("advisorAsk", ORCH_SESSION, lensAsk(projectPath))).rejects.toThrow("not an external-lens lineage");
    expect(calls).toEqual([]);
  });

  test("a lens the provider is not collecting is refused", async () => {
    const { ctx, call, projectPath } = setup({ status: collectStatus("review-risk") });
    markExternalLensLineage(ctx, "repo", LINEAGE);
    await expect(call("advisorAsk", ORCH_SESSION, lensAsk(projectPath))).rejects.toThrow("not collecting");
  });

  test("a lineage that is not collecting reviewer results is refused", async () => {
    const { ctx, call, projectPath } = setup({ status: { status: 0, stderr: "", json: { next_transition: { kind: "stop", reason_code: "target_already_acknowledged" } } } });
    markExternalLensLineage(ctx, "repo", LINEAGE);
    await expect(call("advisorAsk", ORCH_SESSION, lensAsk(projectPath))).rejects.toThrow("not collecting");
  });

  test("a gentle-ai failure fails closed", async () => {
    const { ctx, call, projectPath } = setup({ status: { status: 1, stderr: "boom", json: null } });
    markExternalLensLineage(ctx, "repo", LINEAGE);
    await expect(call("advisorAsk", ORCH_SESSION, lensAsk(projectPath))).rejects.toThrow("review status failed");
  });

  test("a lens-context whose binding disagrees with the provider's subject hash is refused", async () => {
    const { ctx, call, projectPath } = setup({ lensContext: { status: 0, text: lensContextText(`sha256:${"e".repeat(64)}`), stderr: "" } });
    markExternalLensLineage(ctx, "repo", LINEAGE);
    await expect(call("advisorAsk", ORCH_SESSION, lensAsk(projectPath))).rejects.toThrow("subject hash");
  });

  test("the caller cannot supply provider values", async () => {
    const { ctx, call, projectPath } = setup();
    markExternalLensLineage(ctx, "repo", LINEAGE);
    await expect(
      call("advisorAsk", ORCH_SESSION, lensAsk(projectPath, { review: { lineage: LINEAGE, lens: "review-reliability", target: TARGET } })),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("answering a review lens", () => {
  test("a valid reviewer result is stored exactly as submitted", async () => {
    const { ctx, call, projectPath } = setup();
    const id = await askedAndClaimed(projectPath, call, ctx);
    const result = validResult();
    await call("advisorRespond", ADVISOR, { id, status: "submitted", reviewerResult: result });
    const got = await call("advisorGet", ORCH_SESSION, { projectDir: projectPath, id });
    expect(got.status).toBe("submitted");
    expect(got.response.reviewerResult).toEqual(result);
  });

  test("results that gentle-ai would refuse are refused up front", async () => {
    const { ctx, call, projectPath } = setup();
    const id = await askedAndClaimed(projectPath, call, ctx);
    const finding = validResult().findings[0] as Record<string, unknown>;
    const bad: Array<[string, Record<string, unknown>]> = [
      ["subject", validResult({ subject_hash: `sha256:${"f".repeat(64)}` })],
      ["placeholder evidence", validResult({ evidence: ["PASS"] })],
      ["empty evidence", validResult({ evidence: [] })],
      ["extra field", validResult({ verdict: "ok" })],
      ["missing inspection", (() => { const r = validResult(); delete (r as Record<string, unknown>).inspection; return r; })()],
      ["unavailable without reason", validResult({ inspection: { status: "unavailable", paths: [] } })],
      ["completed without paths", validResult({ inspection: { status: "completed", paths: [] } })],
      ["severe without evidence class", validResult({ findings: [{ ...finding, evidence_class: undefined }] })],
      ["bad severity", validResult({ findings: [{ ...finding, severity: "FATAL" }] })],
      ["bad location", validResult({ findings: [{ ...finding, location: "a.ts" }] })],
      ["id prefix for another lens", validResult({ findings: [{ ...finding, id: "R1-divide-by-zero" }] })],
      ["placeholder proof", validResult({ findings: [{ ...finding, proof_refs: ["TODO"] }] })],
      ["unknown finding field", validResult({ findings: [{ ...finding, note: "x" }] })],
    ];
    for (const [label, result] of bad) {
      const clean = JSON.parse(JSON.stringify(result));
      await expect(call("advisorRespond", ADVISOR, { id, status: "submitted", reviewerResult: clean }), label).rejects.toBeInstanceOf(ValidationError);
    }
    expect((await call("advisorGet", ORCH_SESSION, { projectDir: projectPath, id })).status).toBe("claimed");
  });

  test("submitting a review lens requires a reviewer result; declining requires a reason", async () => {
    const { ctx, call, projectPath } = setup();
    const id = await askedAndClaimed(projectPath, call, ctx);
    await expect(call("advisorRespond", ADVISOR, { id, status: "submitted", verdict: "looks fine" })).rejects.toThrow("reviewerResult");
    await expect(call("advisorRespond", ADVISOR, { id, status: "declined", reviewerResult: validResult() })).rejects.toThrow("declined");
    await call("advisorRespond", ADVISOR, { id, status: "declined", verdict: "Cannot inspect the immutable trees." });
    expect((await call("advisorGet", ORCH_SESSION, { projectDir: projectPath, id })).status).toBe("declined");
  });

  test("pre-code advice cannot carry a reviewer result", async () => {
    const { call, projectPath } = setup();
    const { id } = await call("advisorAsk", ORCH_SESSION, {
      projectDir: projectPath,
      kind: "pre-code-advice",
      binding: { task: "odd/tasks/feature-x.md#T1", step: "pre-code" },
      snapshot: { worktree: true },
      host: "claude",
      selection: { rule: "default-rotate" },
      question: "Anything missing?",
    });
    await call("advisorRead", ADVISOR, { id });
    await expect(call("advisorRespond", ADVISOR, { id, status: "submitted", verdict: "x", reviewerResult: validResult() })).rejects.toThrow("review-lens");
  });
});
