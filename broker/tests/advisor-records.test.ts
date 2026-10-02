/**
 * External advisors A3a (odd/tasks/external-advisors.md): advisory request
 * records for pre-code advice. Evidence only: records never issue keys,
 * approve, or call gentle-ai. Claims and responses are published with
 * exclusive file links, so a second claim or response fails at the OS level.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADVISOR_REQUEST_TTL_MS,
  buildAdvisorAskOp,
  buildAdvisorGetOp,
  buildAdvisorListOp,
  buildAdvisorReadOp,
  buildAdvisorRespondOp,
} from "../src/advisor-records.ts";
import { ADVISOR_ALLOWED_OPERATIONS, refuseAdvisorSessionOnMain } from "../src/advisor-socket.ts";
import { defaultConfig } from "../src/config.ts";
import type { OpContext } from "../src/service.ts";
import { PolicyError } from "../src/policy.ts";
import type { BrokerRequestEnvelope } from "../src/types.ts";
import { ValidationError } from "../src/validation.ts";

const ORCH = "gentle-orchestrator";
const ORCH_SESSION = "ses_orchestrator";
const OTHER_SESSION = "ses_worker";
const ADVISOR_A = "advisor-repo-aaaaaaaaaaaaaaaa";
const ADVISOR_B = "advisor-repo-bbbbbbbbbbbbbbbb";
const ADVISOR_OTHER_PROJECT = "advisor-other-cccccccccccccccc";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "advisor-records-"));
  roots.push(root);
  const projectPath = join(root, "repo");
  const otherPath = join(root, "other");
  mkdirSync(projectPath);
  mkdirSync(otherPath);
  const config = defaultConfig({
    stateDir: join(root, "state"),
    projects: [
      { id: "repo", path: projectPath },
      { id: "other", path: otherPath },
    ],
    readOnlyAgents: [ORCH],
  });
  const ctx = {
    config,
    store: {
      get: (id: string) =>
        id === ORCH_SESSION || id === OTHER_SESSION
          ? { sessionID: id, state: "HOST_READ_ONLY", agent: id === ORCH_SESSION ? ORCH : "general", createdAt: "", updatedAt: "" }
          : undefined,
    },
  } as unknown as OpContext;
  let now = 1_800_000_000_000;
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const call = async (op: string, sessionID: string, payload?: Record<string, unknown>) => {
    const req = { version: 1, id: "r", operation: op, sessionID, payload } as BrokerRequestEnvelope;
    const builders: Record<string, (c: OpContext, n: () => number) => (r: BrokerRequestEnvelope) => Promise<unknown>> = {
      advisorAsk: buildAdvisorAskOp,
      advisorGet: buildAdvisorGetOp,
      advisorList: buildAdvisorListOp,
      advisorRead: buildAdvisorReadOp,
      advisorRespond: buildAdvisorRespondOp,
    };
    return (await builders[op]!(ctx, clock.now)(req)) as any;
  };
  return { root, projectPath, otherPath, config, call, clock };
}

const advice = (projectDir: string, extra: Record<string, unknown> = {}) => ({
  projectDir,
  kind: "pre-code-advice",
  binding: { task: "odd/tasks/feature-x.md#T1", step: "pre-code" },
  snapshot: { worktree: true },
  host: "rotate",
  selection: { rule: "default-rotate" },
  question: "What is wrong or missing in this approach?",
  ...extra,
});

describe("asking", () => {
  test("a pre-code-advice request is created pending, in its own thread", async () => {
    const { call, projectPath } = setup();
    const asked = await call("advisorAsk", ORCH_SESSION, advice(projectPath));
    expect(asked.id).toMatch(/^adv-[0-9a-f]{16}$/);
    expect(asked).toMatchObject({ thread: asked.id, status: "pending" });
    const got = await call("advisorGet", ORCH_SESSION, { projectDir: projectPath, id: asked.id });
    expect(got).toMatchObject({
      id: asked.id,
      kind: "pre-code-advice",
      status: "pending",
      binding: { task: "odd/tasks/feature-x.md#T1", step: "pre-code" },
      selection: { rule: "default-rotate", requestedHost: "rotate", resolvedHost: "claude", override: null },
    });
    expect(got.response).toBeUndefined();
  });

  test("only an orchestrator session may ask", async () => {
    const { call, projectPath } = setup();
    await expect(call("advisorAsk", OTHER_SESSION, advice(projectPath))).rejects.toBeInstanceOf(PolicyError);
  });

  test("malformed requests are refused", async () => {
    const { call, projectPath } = setup();
    const bad: Array<Record<string, unknown>> = [
      advice(projectPath, { binding: { step: "pre-code" } }),
      advice(projectPath, { binding: { task: "notes.md", step: "pre-code" } }),
      advice(projectPath, { kind: "approval" }),
      advice(projectPath, { selection: {} }),
      advice(projectPath, { host: "gpt" }),
      advice(projectPath, { snapshot: { commit: "abc" } }),
      advice(projectPath, { snapshot: { resultRef: "refs/heads/main" } }),
      advice(projectPath, { question: "" }),
      advice(projectPath, { question: "x".repeat(64 * 1024 + 1) }),
    ];
    for (const payload of bad) {
      await expect(call("advisorAsk", ORCH_SESSION, payload)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  test("an acknowledgement token can never ride along", async () => {
    const { call, projectPath } = setup();
    await expect(call("advisorAsk", ORCH_SESSION, advice(projectPath, { token: "abc" }))).rejects.toThrow("token");
  });

  test("a review-lens request needs a lineage started for external advisors (A3b)", async () => {
    const { call, projectPath } = setup();
    await expect(
      call("advisorAsk", ORCH_SESSION, advice(projectPath, { kind: "review-lens", review: { lineage: "review-x", lens: "review-risk" } })),
    ).rejects.toThrow("not an external-lens lineage");
  });

  test("rotate alternates hosts per project; an explicit host is kept", async () => {
    const { call, projectPath, otherPath } = setup();
    const hosts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await call("advisorAsk", ORCH_SESSION, advice(projectPath));
      hosts.push((await call("advisorGet", ORCH_SESSION, { projectDir: projectPath, id: a.id })).selection.resolvedHost);
    }
    expect(hosts).toEqual(["claude", "agy", "claude"]);
    const other = await call("advisorAsk", ORCH_SESSION, advice(otherPath));
    expect((await call("advisorGet", ORCH_SESSION, { projectDir: otherPath, id: other.id })).selection.resolvedHost).toBe("claude");
    const fixed = await call("advisorAsk", ORCH_SESSION, advice(projectPath, { host: "agy", selection: { rule: "consequential-pair" }, group: "grp-1" }));
    expect(await call("advisorGet", ORCH_SESSION, { projectDir: projectPath, id: fixed.id })).toMatchObject({
      group: "grp-1",
      selection: { requestedHost: "agy", resolvedHost: "agy", rule: "consequential-pair" },
    });
  });

  test("concurrent rotate asks never resolve to the same host twice in a row (R3-rotate-race)", async () => {
    const { call, projectPath } = setup();
    const asked = await Promise.all(Array.from({ length: 10 }, () => call("advisorAsk", ORCH_SESSION, advice(projectPath))));
    const hosts = await Promise.all(
      asked.map(async (a: { id: string }) => (await call("advisorGet", ORCH_SESSION, { projectDir: projectPath, id: a.id })).selection.resolvedHost),
    );
    // Strict alternation in creation order proves no read-modify-write interleaved.
    expect(hosts).toEqual(["claude", "agy", "claude", "agy", "claude", "agy", "claude", "agy", "claude", "agy"]);
  });

  test("a follow-up is a new request in its parent's thread", async () => {
    const { call, projectPath } = setup();
    const first = await call("advisorAsk", ORCH_SESSION, advice(projectPath));
    const follow = await call("advisorAsk", ORCH_SESSION, advice(projectPath, { parentId: first.id }));
    expect(follow.id).not.toBe(first.id);
    expect(follow.thread).toBe(first.id);
    await expect(call("advisorAsk", ORCH_SESSION, advice(projectPath, { parentId: "adv-0000000000000000" }))).rejects.toThrow("parent");
  });
});

describe("reading and responding", () => {
  test("the first advisor to read claims the request; others are refused", async () => {
    const { call, projectPath } = setup();
    const { id } = await call("advisorAsk", ORCH_SESSION, advice(projectPath));
    const read = await call("advisorRead", ADVISOR_A, { id });
    expect(read).toMatchObject({ id, kind: "pre-code-advice", question: "What is wrong or missing in this approach?", status: "claimed" });
    // An advisor sees its request only: no response field, no other records.
    expect(Object.keys(read).sort()).toEqual(
      ["binding", "evidenceRefs", "id", "kind", "parentId", "question", "resolvedHost", "snapshot", "status", "thread"].sort(),
    );
    expect(await call("advisorRead", ADVISOR_A, { id })).toMatchObject({ status: "claimed" });
    await expect(call("advisorRead", ADVISOR_B, { id })).rejects.toThrow("claimed by another advisor");
    await expect(call("advisorRead", ADVISOR_OTHER_PROJECT, { id })).rejects.toThrow("not found");
  });

  test("a response is accepted once, only from the claiming advisor, and never changes", async () => {
    const { call, projectPath } = setup();
    const { id } = await call("advisorAsk", ORCH_SESSION, advice(projectPath));
    const answer = { id, status: "submitted", verdict: "Missing a rollback step.", findings: [{ claim: "no rollback", severity: "WARNING" }] };
    await expect(call("advisorRespond", ADVISOR_A, answer)).rejects.toThrow("not claimed");
    await call("advisorRead", ADVISOR_A, { id });
    await expect(call("advisorRespond", ADVISOR_B, answer)).rejects.toThrow("claimed by another advisor");
    expect(await call("advisorRespond", ADVISOR_A, answer)).toMatchObject({ id, status: "submitted" });
    await expect(call("advisorRespond", ADVISOR_A, { ...answer, verdict: "changed my mind" })).rejects.toThrow("already");
    const got = await call("advisorGet", ORCH_SESSION, { projectDir: projectPath, id });
    expect(got).toMatchObject({ status: "submitted", response: { verdict: "Missing a rollback step." }, advisor: { session: ADVISOR_A } });
  });

  test("an advisor may decline", async () => {
    const { call, projectPath } = setup();
    const { id } = await call("advisorAsk", ORCH_SESSION, advice(projectPath));
    await call("advisorRead", ADVISOR_A, { id });
    await call("advisorRespond", ADVISOR_A, { id, status: "declined", verdict: "Outside my competence." });
    expect((await call("advisorGet", ORCH_SESSION, { projectDir: projectPath, id })).status).toBe("declined");
  });

  test("an unanswered request expires and can then be neither read nor answered", async () => {
    const { call, projectPath, clock } = setup();
    const { id } = await call("advisorAsk", ORCH_SESSION, advice(projectPath));
    await call("advisorRead", ADVISOR_A, { id });
    clock.advance(ADVISOR_REQUEST_TTL_MS + 1);
    expect((await call("advisorGet", ORCH_SESSION, { projectDir: projectPath, id })).status).toBe("expired");
    await expect(call("advisorRead", ADVISOR_A, { id })).rejects.toThrow("expired");
    await expect(call("advisorRespond", ADVISOR_A, { id, status: "submitted", verdict: "late" })).rejects.toThrow("expired");
  });

  test("main-socket sessions cannot read or respond as an advisor", async () => {
    const { call, projectPath } = setup();
    const { id } = await call("advisorAsk", ORCH_SESSION, advice(projectPath));
    await expect(call("advisorRead", ORCH_SESSION, { id })).rejects.toThrow("advisor");
  });

  test("list filters by task and status", async () => {
    const { call, projectPath } = setup();
    const a = await call("advisorAsk", ORCH_SESSION, advice(projectPath));
    await call("advisorAsk", ORCH_SESSION, advice(projectPath, { binding: { task: "odd/tasks/feature-y.md#T2", step: "pre-code" } }));
    await call("advisorRead", ADVISOR_A, { id: a.id });
    await call("advisorRespond", ADVISOR_A, { id: a.id, status: "submitted", verdict: "ok" });
    const byTask = await call("advisorList", ORCH_SESSION, { projectDir: projectPath, task: "odd/tasks/feature-x.md#T1" });
    expect(byTask.map((r: { id: string }) => r.id)).toEqual([a.id]);
    const pending = await call("advisorList", ORCH_SESSION, { projectDir: projectPath, status: "pending" });
    expect(pending.length).toBe(1);
  });

  test("records are private: directories 0700, files 0600", async () => {
    const { call, projectPath, config } = setup();
    const { id } = await call("advisorAsk", ORCH_SESSION, advice(projectPath));
    await call("advisorRead", ADVISOR_A, { id });
    const dir = join(config.stateDir, "advisor", "repo", "requests");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
  });
});

describe("socket wiring", () => {
  test("advisorRead and advisorRespond are on the advisor allowlist; ask/get/list are not", () => {
    expect(ADVISOR_ALLOWED_OPERATIONS.has("advisorRead")).toBe(true);
    expect(ADVISOR_ALLOWED_OPERATIONS.has("advisorRespond")).toBe(true);
    for (const op of ["advisorAsk", "advisorGet", "advisorList"]) expect(ADVISOR_ALLOWED_OPERATIONS.has(op)).toBe(false);
  });

  test("the main socket refuses the advisor-only operations", () => {
    for (const operation of ["advisorRead", "advisorRespond"]) {
      const req = { version: 1, id: "x", operation, sessionID: "ses_abc" } as BrokerRequestEnvelope;
      expect(() => refuseAdvisorSessionOnMain(req)).toThrow(PolicyError);
    }
  });
});
