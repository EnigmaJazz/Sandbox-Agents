/**
 * External advisors A4 (odd/tasks/external-advisors.md): start a review as an
 * external-lens lineage, and relay ONLY stored advisor responses into
 * gentle-ai's capture. gentle-ai trusts submitted content, so on an
 * external-lens lineage a free-form input would let whoever submits approve.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExternalLensLineage } from "../src/advisor-lineages.ts";
import { buildAdvisorAskOp, buildAdvisorReadOp, buildAdvisorRespondOp } from "../src/advisor-records.ts";
import { defaultConfig } from "../src/config.ts";
import { buildReviewCaptureResultOp, buildReviewStartOp, type SddOpContext } from "../src/sdd-service.ts";
import type { BrokerRequestEnvelope } from "../src/types.ts";

const ORCH = "gentle-orchestrator";
const ORCH_SESSION = "ses_orchestrator";
const ADVISOR = "advisor-repo-aaaaaaaaaaaaaaaa";
const LINEAGE = "review-d6d1312c5655c0de";
const SUBJECT = `sha256:${"a".repeat(64)}`;
const TARGET = `sha256:${"b".repeat(64)}`;

interface Provider {
  target: string;
  subject: string;
  revision: string;
  context: string;
  collecting: boolean;
}

function collect(p: Provider) {
  return {
    status: 0,
    stderr: "",
    json: {
      next_transition: p.collecting
        ? {
            kind: "collect",
            collect: {
              inputs: [
                {
                  arguments: [
                    { name: "lineage", value: LINEAGE },
                    { name: "expected-revision", value: p.revision },
                    { name: "target", value: p.target },
                    { name: "repository-context", value: p.context },
                    { name: "lens", value: "review-reliability" },
                    { name: "order", value: "0" },
                    { name: "subject-hash", value: p.subject },
                  ],
                },
              ],
            },
          }
        : { kind: "stop", reason_code: "target_already_acknowledged" },
    },
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "advisor-relay-"));
  roots.push(root);
  const projectPath = join(root, "repo");
  mkdirSync(projectPath);
  const provider: Provider = { target: TARGET, subject: SUBJECT, revision: `sha256:${"c".repeat(64)}`, context: "rctx2_one", collecting: true };
  const captures: Array<Record<string, unknown>> = [];
  const starts: Array<Record<string, unknown>> = [];
  const capturePlan: { preflight: unknown; capture: unknown } = {
    preflight: { status: 0, stderr: "", json: { validation: "accepted", admission_decision: "completed" } },
    capture: { status: 0, stderr: "", json: { state: "approved" } },
  };
  const ctx = {
    config: defaultConfig({ stateDir: join(root, "state"), projects: [{ id: "repo", path: projectPath }], readOnlyAgents: [ORCH] }),
    store: {
      get: (id: string) => (id === ORCH_SESSION ? { sessionID: id, state: "HOST_READ_ONLY", agent: ORCH, createdAt: "", updatedAt: "" } : undefined),
    },
    sddRuntime: {
      reviewStatus: async () => collect(provider),
      reviewLensContext: async () => ({
        status: 0,
        stderr: "",
        text: `GENTLE_AI_REVIEW_BINDING ${JSON.stringify({ subject_hash: provider.subject })}\nReview it.`,
      }),
      reviewStart: async (payload: Record<string, unknown>) => {
        starts.push(payload);
        return { status: 0, stderr: "", json: { lineage_id: LINEAGE, state: "reviewing", action: "created" } };
      },
      reviewCaptureResult: async (payload: Record<string, unknown>) => {
        captures.push(payload);
        return payload.preflight ? capturePlan.preflight : capturePlan.capture;
      },
    },
  } as unknown as SddOpContext;
  const req = (operation: string, sessionID: string, payload: Record<string, unknown>) =>
    ({ version: 1, id: "r", operation, sessionID, payload }) as BrokerRequestEnvelope;
  const start = (payload: Record<string, unknown>) => buildReviewStartOp(ctx)(req("reviewStart", ORCH_SESSION, { projectDir: projectPath, ...payload }));
  const capture = (payload: Record<string, unknown>) =>
    buildReviewCaptureResultOp(ctx)(req("reviewCaptureResult", ORCH_SESSION, { projectDir: projectPath, ...payload })) as Promise<any>;
  const result = () => ({
    subject_hash: provider.subject,
    inspection: { status: "completed", paths: ["a.ts"] },
    findings: [],
    evidence: ["inspected a.ts in full in an isolated worker"],
  });
  const ask = async () =>
    (
      (await buildAdvisorAskOp(ctx)(
        req("advisorAsk", ORCH_SESSION, {
          projectDir: projectPath,
          kind: "review-lens",
          binding: { task: "odd/tasks/f.md#T1", step: "review" },
          snapshot: { worktree: true },
          host: "rotate",
          selection: { rule: "review-lens-external" },
          review: { lineage: LINEAGE, lens: "review-reliability" },
        }),
      )) as { id: string }
    ).id;
  const submitted = async () => {
    const id = await ask();
    await buildAdvisorReadOp(ctx)(req("advisorRead", ADVISOR, { id }));
    await buildAdvisorRespondOp(ctx)(req("advisorRespond", ADVISOR, { id, status: "submitted", reviewerResult: result() }));
    return id;
  };
  return { ctx, provider, captures, starts, capturePlan, start, capture, ask, submitted, result, projectPath };
}

describe("starting an external-lens review", () => {
  test("externalLenses starts without a runtime agent and registers the lineage", async () => {
    const { ctx, start, starts } = setup();
    await start({ externalLenses: true, target: TARGET });
    expect(starts).toHaveLength(1);
    expect(starts[0]!.agent).toBeUndefined();
    expect(starts[0]!.externalLenses).toBeUndefined();
    expect(isExternalLensLineage(ctx, "repo", LINEAGE)).toBe(true);
  });

  test("externalLenses with an agent is refused", async () => {
    const { start, starts } = setup();
    await expect(start({ externalLenses: true, agent: "opencode" })).rejects.toThrow("externalLenses");
    expect(starts).toHaveLength(0);
  });

  test("an ordinary start registers nothing", async () => {
    const { ctx, start } = setup();
    await start({ agent: "opencode" });
    expect(isExternalLensLineage(ctx, "repo", LINEAGE)).toBe(false);
  });
});

describe("relaying a stored advisor response", () => {
  test("the broker builds the capture from fresh provider values, preflights, then captures the stored bytes", async () => {
    const { start, submitted, capture, captures, provider, result } = setup();
    await start({ externalLenses: true });
    const id = await submitted();
    // The provider's revision and context moved on since the request was asked.
    provider.revision = `sha256:${"9".repeat(64)}`;
    provider.context = "rctx2_two";
    const out = await capture({ inputFromAdvisorResponse: id });
    expect(captures).toHaveLength(2);
    const [pre, real] = captures as Array<Record<string, unknown>>;
    for (const c of [pre!, real!]) {
      expect(c).toMatchObject({
        lineage: LINEAGE,
        lens: "review-reliability",
        order: 0,
        target: TARGET,
        subjectHash: SUBJECT,
        expectedRevision: provider.revision,
        repositoryContext: "rctx2_two",
        inputJson: JSON.stringify(result()),
      });
      expect(c.agent).toBeUndefined();
      expect(c.input).toBeUndefined();
    }
    expect(pre!.preflight).toBe(true);
    expect(real!.preflight).toBeUndefined();
    expect(out).toMatchObject({ relayedAdvisoryResponse: id });
  });

  test("a lens is relayed at most once", async () => {
    const { start, submitted, capture } = setup();
    await start({ externalLenses: true });
    const id = await submitted();
    await capture({ inputFromAdvisorResponse: id });
    await expect(capture({ inputFromAdvisorResponse: id })).rejects.toThrow("already relayed");
  });

  test("missing, unanswered, declined or pre-code responses never reach gentle-ai", async () => {
    const { ctx, start, ask, capture, captures, projectPath } = setup();
    await start({ externalLenses: true });
    await expect(capture({ inputFromAdvisorResponse: "adv-0000000000000000" })).rejects.toThrow("not found");
    const pending = await ask();
    await expect(capture({ inputFromAdvisorResponse: pending })).rejects.toThrow("submitted");
    const req = (operation: string, sessionID: string, payload: Record<string, unknown>) =>
      ({ version: 1, id: "r", operation, sessionID, payload }) as BrokerRequestEnvelope;
    await buildAdvisorReadOp(ctx)(req("advisorRead", ADVISOR, { id: pending }));
    await expect(capture({ inputFromAdvisorResponse: pending })).rejects.toThrow("submitted");
    await buildAdvisorRespondOp(ctx)(req("advisorRespond", ADVISOR, { id: pending, status: "declined", verdict: "cannot inspect" }));
    await expect(capture({ inputFromAdvisorResponse: pending })).rejects.toThrow("submitted");
    const precode = (await buildAdvisorAskOp(ctx)(
      req("advisorAsk", ORCH_SESSION, {
        projectDir: projectPath,
        kind: "pre-code-advice",
        binding: { task: "odd/tasks/f.md#T1", step: "pre" },
        snapshot: { worktree: true },
        host: "claude",
        selection: { rule: "default-rotate" },
        question: "?",
      }),
    )) as { id: string };
    await expect(capture({ inputFromAdvisorResponse: precode.id })).rejects.toThrow("review-lens");
    expect(captures).toHaveLength(0);
  });

  test("a response for a candidate that has since changed is refused as stale", async () => {
    const { start, submitted, capture, captures, provider } = setup();
    await start({ externalLenses: true });
    const id = await submitted();
    provider.subject = `sha256:${"e".repeat(64)}`;
    await expect(capture({ inputFromAdvisorResponse: id })).rejects.toThrow("stale");
    provider.subject = SUBJECT;
    provider.target = `sha256:${"d".repeat(64)}`;
    await expect(capture({ inputFromAdvisorResponse: id })).rejects.toThrow("stale");
    provider.target = TARGET;
    provider.collecting = false;
    await expect(capture({ inputFromAdvisorResponse: id })).rejects.toThrow("not collecting");
    expect(captures).toHaveLength(0);
  });

  test("the caller cannot supply provider values or input alongside a stored response", async () => {
    const { start, submitted, capture, captures } = setup();
    await start({ externalLenses: true });
    const id = await submitted();
    for (const extra of [{ lineage: LINEAGE }, { target: TARGET }, { inputJson: "{}" }, { input: "r.json" }, { agent: "opencode" }, { subjectHash: SUBJECT }]) {
      await expect(capture({ inputFromAdvisorResponse: id, ...extra })).rejects.toThrow("inputFromAdvisorResponse");
    }
    expect(captures).toHaveLength(0);
  });

  test("a preflight refusal stops before the real capture and leaves the lens relayable", async () => {
    const { start, submitted, capture, captures, capturePlan } = setup();
    await start({ externalLenses: true });
    const id = await submitted();
    capturePlan.preflight = { status: 1, stderr: "binding_mismatch", json: null };
    await expect(capture({ inputFromAdvisorResponse: id })).rejects.toThrow("preflight");
    expect(captures).toHaveLength(1);
    capturePlan.preflight = { status: 0, stderr: "", json: { validation: "accepted" } };
    await capture({ inputFromAdvisorResponse: id });
    expect(captures).toHaveLength(3);
  });
});

describe("closing the self-approval hole", () => {
  test("free-form input and agents are refused on an external-lens lineage", async () => {
    const { start, capture, captures } = setup();
    await start({ externalLenses: true });
    await expect(capture({ lineage: LINEAGE, inputJson: '{"findings":[]}' })).rejects.toThrow("external-lens");
    await expect(capture({ lineage: LINEAGE, input: "result.json" })).rejects.toThrow("external-lens");
    await expect(capture({ lineage: LINEAGE, agent: "opencode" })).rejects.toThrow("external-lens");
    expect(captures).toHaveLength(0);
  });

  test("ordinary lineages keep their existing capture behaviour", async () => {
    const { capture, captures } = setup();
    await capture({ lineage: "review-0123456789abcdef", agent: "opencode" });
    expect(captures).toHaveLength(1);
  });
});
