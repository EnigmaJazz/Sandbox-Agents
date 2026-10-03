/**
 * External advisors A3a (odd/tasks/external-advisors.md): advisory request
 * records for pre-code advice. Evidence only: records never issue keys,
 * approve, or call gentle-ai. Claims and responses are published with
 * exclusive file links, so a second claim or response fails at the OS level.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADVISOR_REQUEST_TTL_MS,
  buildAdvisorAskOp,
  buildAdvisorGetOp,
  buildAdvisorEvidenceKeepOp,
  buildAdvisorListOp,
  buildAdvisorReadOp,
  buildAdvisorRespondOp,
} from "../src/advisor-records.ts";
import { ADVISOR_ALLOWED_OPERATIONS, refuseAdvisorSessionOnMain } from "../src/advisor-socket.ts";
import { defaultConfig } from "../src/config.ts";
import type { OpContext } from "../src/service.ts";
import { PolicyError } from "../src/policy.ts";
import { OPERATIONS } from "../src/types.ts";
import type { BrokerRequestEnvelope } from "../src/types.ts";
import { ALLOWED_PAYLOAD_KEYS, ValidationError } from "../src/validation.ts";

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
  const workerFiles = new Map<string, Buffer>();
  const symlinks = new Set<string>();
  const failReads = new Set<string>();
  const adapter = {
    exec: async (_worker: string, argv: string[]) => {
      const [command, ...args] = argv;
      const path = args.at(-1)!;
      const key = path.startsWith(".advisor/") ? path.slice(".advisor/".length) : path;
      if (command === "git") return { status: 0, stdout: `${"a".repeat(40)}\n`, stderr: "", timedOut: false };
      if (command === "realpath") return { status: 0, stdout: `${path.includes("..") ? "/work/secret" : `/work/.advisor/${key}`}\n`, stderr: "", timedOut: false };
      if (command === "stat") return { status: 0, stdout: `${symlinks.has(key) ? "symbolic link" : "regular file"}\n`, stderr: "", timedOut: false };
      if (command === "base64") return failReads.has(key)
        ? { status: 1, stdout: "", stderr: "read failed", timedOut: false }
        : { status: 0, stdout: (workerFiles.get(key) ?? Buffer.alloc(0)).toString("base64"), stderr: "", timedOut: false };
      return { status: 1, stdout: "", stderr: "unsupported", timedOut: false };
    },
  };
  const ctx = {
    config,
    adapter,
    store: {
      get: (id: string) =>
        id === ORCH_SESSION || id === OTHER_SESSION
          ? { sessionID: id, state: "HOST_READ_ONLY", agent: id === ORCH_SESSION ? ORCH : "general", createdAt: "", updatedAt: "" }
          : id === ADVISOR_A || id === ADVISOR_B
            ? { sessionID: id, state: "SANDBOX_ACTIVE", workerName: `worker-${id}`, projectID: "repo", baselineRef: "refs/opencode-sandbox/baseline/pinned", createdAt: "", updatedAt: "" }
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
      evidenceKeep: buildAdvisorEvidenceKeepOp,
    };
    return (await builders[op]!(ctx, clock.now)(req)) as any;
  };
  return { root, projectPath, otherPath, config, call, clock, workerFiles, symlinks, failReads };
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

describe("evidenceKeep wiring", () => {
  test("registers an advisor-only operation with only requestId and paths", () => {
    expect(OPERATIONS).toContain("evidenceKeep");
    expect(ALLOWED_PAYLOAD_KEYS.evidenceKeep).toEqual(["requestId", "paths"]);
    expect(ADVISOR_ALLOWED_OPERATIONS.has("evidenceKeep")).toBe(true);
  });
});

describe("evidenceKeep", () => {
  async function newClaim(s: ReturnType<typeof setup>): Promise<string> {
    const asked = await s.call("advisorAsk", ORCH_SESSION, advice(s.projectPath));
    await s.call("advisorRead", ADVISOR_A, { id: asked.id });
    return asked.id;
  }

  test("refuses paths outside the worker .advisor directory", async () => {
    const s = setup();
    const id = await newClaim(s);
    await expect(s.call("evidenceKeep", ADVISOR_A, { requestId: id, paths: [".advisor/../secret"] })).rejects.toThrow();
  });

  test("refuses a final-component symlink", async () => {
    const s = setup();
    const id = await newClaim(s);
    s.symlinks.add("link");
    await expect(s.call("evidenceKeep", ADVISOR_A, { requestId: id, paths: [".advisor/link"] })).rejects.toThrow("unsymlinked regular file");
  });

  test("refuses more than 32 paths before copying", async () => {
    const s = setup();
    const id = await newClaim(s);
    await expect(s.call("evidenceKeep", ADVISOR_A, { requestId: id, paths: Array(33).fill(".advisor/a") })).rejects.toThrow("at most 32");
  });

  test("refuses a file over 1 MiB", async () => {
    const s = setup();
    const id = await newClaim(s);
    s.workerFiles.set("large", Buffer.alloc(1024 * 1024 + 1));
    await expect(s.call("evidenceKeep", ADVISOR_A, { requestId: id, paths: [".advisor/large"] })).rejects.toThrow("exceeds 1048576 bytes");
  });

  test("refuses a cumulative set over 8 MiB", async () => {
    const s = setup();
    const id = await newClaim(s);
    for (let i = 0; i < 9; i++) s.workerFiles.set(`f${i}`, Buffer.alloc(1024 * 1024));
    await expect(s.call("evidenceKeep", ADVISOR_A, { requestId: id, paths: Array.from({ length: 9 }, (_, i) => `.advisor/f${i}`) })).rejects.toThrow("set exceeds 8388608 bytes");
  });

  test("refuses a non-claiming advisor", async () => {
    const s = setup();
    const id = await newClaim(s);
    await expect(s.call("evidenceKeep", ADVISOR_B, { requestId: id, paths: [] })).rejects.toThrow("claimed by another advisor");
  });

  test("refuses evidence after response exists", async () => {
    const s = setup();
    const id = await newClaim(s);
    await s.call("advisorRespond", ADVISOR_A, { id, status: "submitted", verdict: "done" });
    await expect(s.call("evidenceKeep", ADVISOR_A, { requestId: id, paths: [] })).rejects.toThrow("after the request was answered");
  });

  test("publishes one manifest with hashes of copied bytes and refuses a second call", async () => {
    const s = setup();
    const id = await newClaim(s);
    const bytes = Buffer.from([0xff, 0x00, 0x81]);
    s.workerFiles.set("binary", bytes);
    const kept = await s.call("evidenceKeep", ADVISOR_A, { requestId: id, paths: [".advisor/binary"] });
    const evidenceDir = join(s.config.stateDir, "advisor", "repo", "requests", "evidence", id);
    const manifest = JSON.parse(readFileSync(join(evidenceDir, "manifest.json"), "utf8"));
    expect(readFileSync(join(evidenceDir, "binary"))).toEqual(bytes);
    expect(manifest.files[0].sha256).toBe(`sha256:${await import("node:crypto").then(({ createHash }) => createHash("sha256").update(bytes).digest("hex"))}`);
    expect(kept.evidence.manifestSha256).toStartWith("sha256:");
    await expect(s.call("evidenceKeep", ADVISOR_A, { requestId: id, paths: [".advisor/binary"] })).rejects.toThrow("already kept");
    await s.call("advisorRespond", ADVISOR_A, { id, status: "submitted", verdict: "done" });
    expect((await s.call("advisorGet", ORCH_SESSION, { projectDir: s.projectPath, id })).evidence).toEqual(kept.evidence);
  });

  test("a partial copy failure leaves no published evidence directory", async () => {
    const s = setup();
    const id = await newClaim(s);
    s.workerFiles.set("first", Buffer.from("ok"));
    s.failReads.add("second");
    await expect(s.call("evidenceKeep", ADVISOR_A, { requestId: id, paths: [".advisor/first", ".advisor/second"] })).rejects.toThrow("read failed");
    expect(existsSync(join(s.config.stateDir, "advisor", "repo", "requests", "evidence", id))).toBe(false);
  });
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
    for (const operation of ["advisorRead", "advisorRespond", "evidenceKeep"]) {
      const req = { version: 1, id: "x", operation, sessionID: "ses_abc" } as BrokerRequestEnvelope;
      expect(() => refuseAdvisorSessionOnMain(req)).toThrow(PolicyError);
    }
  });
});
