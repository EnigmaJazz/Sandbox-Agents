import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import * as service from "../src/service.ts";
import type { OpContext } from "../src/service.ts";
import { StateError } from "../src/state.ts";
import { ValidationError } from "../src/validation.ts";
import { ADVISOR_ALLOWED_OPERATIONS, ADVISOR_ONLY_OPERATIONS } from "../src/advisor-socket.ts";
import { ALLOWED_PAYLOAD_KEYS } from "../src/validation.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const projectRoot = process.cwd();
const RESULT_REF = "refs/opencode-sandbox/result/worker-7";
const BASELINE_REF = "refs/opencode-sandbox/baseline/worker-7";
const IDENTITY = "0123456789abcdef0123456789abcdef01234567\u00002026-09-23T10:00:00+00:00\u0000fix: worker seven\n";

function request(ref: unknown): BrokerRequestEnvelope {
  return {
    version: 1,
    id: "req-resultDiff",
    operation: "resultDiff" as BrokerRequestEnvelope["operation"],
    sessionID: "advisor-test-0123456789abcdef",
    agent: "external-advisor",
    payload: { ref },
  };
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionID: "worker-7",
    state: "RESULT_READY",
    projectID: "test",
    baselineRef: BASELINE_REF,
    resultRef: RESULT_REF,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeCtx(spawn: OpContext["git"]["spawn"], records: Record<string, SessionRecord>): OpContext {
  return {
    config: defaultConfig({ advisorProjects: ["test"], projects: [{ id: "test", path: projectRoot }] }),
    store: { get: (sessionID: string) => records[sessionID] },
    adapter: {}, budget: {}, resources: {}, pool: { allocations: [] },
    hostRead: { has: () => false }, logger: {},
    git: { runnerMode: "planned", spawn },
  } as unknown as OpContext;
}

function spawnStub(patch: string) {
  const calls: string[][] = [];
  const spawn: OpContext["git"]["spawn"] = async (argv) => {
    calls.push(argv);
    if (argv[1] === "rev-parse") return { status: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n", stderr: "", timedOut: false };
    if (argv[1] === "show") return { status: 0, stdout: IDENTITY, stderr: "", timedOut: false };
    if (argv.includes("--numstat")) return { status: 0, stdout: "1\t0\ta.ts\u0000", stderr: "", timedOut: false };
    if (argv.includes("--name-only")) return { status: 0, stdout: "a.ts\u0000", stderr: "", timedOut: false };
    if (argv[1] === "diff") return { status: 0, stdout: patch, stderr: "", timedOut: false };
    return { status: 1, stdout: "", stderr: "unexpected argv", timedOut: false };
  };
  return { calls, spawn };
}

const buildResultDiffOp = (service as unknown as {
  buildResultDiffOp?: (ctx: OpContext) => (req: BrokerRequestEnvelope) => Promise<unknown>;
}).buildResultDiffOp;

describe("resultDiff advisor read", () => {
  test("returns the expected bounded base-to-result diff and reports its bound", async () => {
    const diff = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const { calls, spawn } = spawnStub(diff);
    const state = { "worker-7": record() };
    const result = await buildResultDiffOp!(makeCtx(spawn, state))(
      request(RESULT_REF),
    ) as { ref: string; baseline: string; result: string; diff: string; truncated: boolean; truncation: { helper: string; maxLines: number } };
    expect(result).toMatchObject({ ref: RESULT_REF, baseline: BASELINE_REF, result: RESULT_REF, diff, truncated: false });
    expect(result.truncation).toMatchObject({ helper: "buildApplyPreview", maxLines: 400 });
    expect(calls.some((argv) => argv.includes(BASELINE_REF) && argv.includes(RESULT_REF))).toBe(true);
    expect(calls.every((argv) => argv[0] === "git" && !["reset", "checkout", "fetch", "update-ref"].includes(argv[1]!))).toBe(true);
    expect(state["worker-7"].resultRef).toBe(RESULT_REF);
    expect(state["worker-7"].state).toBe("RESULT_READY");
  });

  test("refuses a well-formed result ref that does not resolve in this project", async () => {
    const { calls, spawn } = spawnStub("");
    await expect(buildResultDiffOp!(makeCtx(spawn, {}))(request("refs/opencode-sandbox/result/ghost"))).rejects.toThrow(StateError);
    expect(calls).toHaveLength(0);
  });

  test("refuses arbitrary branches, revision expressions, short SHAs, and absent refs", async () => {
    const { calls, spawn } = spawnStub("");
    const handler = buildResultDiffOp!(makeCtx(spawn, { "worker-7": record() }));
    for (const ref of ["feature/foo", "HEAD~1", "0123456789ab", undefined, null]) {
      await expect(handler(request(ref))).rejects.toThrow(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  test("truncates at the apply-preview line bound and reports truncation", async () => {
    const diff = Array.from({ length: 405 }, (_, index) => `+line-${index}`).join("\n");
    const { spawn } = spawnStub(diff);
    const result = await buildResultDiffOp!(makeCtx(spawn, { "worker-7": record() }))(
      request(RESULT_REF),
    ) as { diff: string; truncated: boolean; truncation: { helper: string; maxLines: number } };
    expect(result.truncated).toBe(true);
    expect(result.diff).toContain("preview truncated: showing 400 of 405 lines");
    expect(result.truncation).toEqual({ helper: "buildApplyPreview", maxLines: 400, maxBytes: 512 * 1024 });
  });

  test("is advisor-allowed without becoming advisor-only", () => {
    expect(ADVISOR_ALLOWED_OPERATIONS.has("resultDiff")).toBe(true);
    expect(ADVISOR_ONLY_OPERATIONS.has("resultDiff")).toBe(false);
    expect(ALLOWED_PAYLOAD_KEYS.resultDiff).toEqual(["ref"]);
  });
});
