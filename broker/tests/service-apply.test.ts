import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { buildApplyResultOp, type OpContext } from "../src/service.ts";
import type { BrokerRequestEnvelope, SessionRecord, SessionState } from "../src/types.ts";

function makeApplyContext(rawDiff: string, calls: string[][]): OpContext {
  let record: SessionRecord = {
    sessionID: "apply-session",
    projectID: "repo",
    state: "RESULT_READY",
    workerName: "worker-apply-session",
    workerState: "ACTIVE",
    baselineRef: "refs/opencode-sandbox/baseline/apply-session",
    resultRef: "refs/opencode-sandbox/result/apply-session",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const store = {
    get: () => record,
    transition: (_sessionID: string, from: SessionState, to: SessionState, patch: Partial<SessionRecord> = {}) => {
      if (record.state !== from) throw new Error(`unexpected state ${record.state}, expected ${from}`);
      record = { ...record, ...patch, state: to };
      return record;
    },
  };

  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "", timedOut: false });

  return {
    config: defaultConfig({
      stateDir: "/tmp/opencode-sandbox-apply-test",
      projects: [{ id: "repo", path: "/repo" }],
    }),
    store,
    adapter: {
      stop: async () => undefined,
      remove: async () => undefined,
    },
    pool: { allocations: [] },
    hostRead: { has: () => false },
    logger: {},
    resources: {},
    budget: {},
    git: {
      runnerMode: "real",
      spawn: async (argv: string[]) => {
        calls.push(argv);
        if (argv.includes("add")) return ok();
        if (argv.includes("ls-files")) return ok("100644 base 0\topenspec/link\n");
        if (argv.includes("ls-tree")) return ok("100644 blob base\topenspec/link\n");
        if (argv.includes("--name-only")) return ok("openspec/link\u0000");
        if (argv.includes("--raw")) return ok(rawDiff);
        return ok();
      },
    },
  } as unknown as OpContext;
}

const applyRequest: BrokerRequestEnvelope = {
  version: 1,
  id: "apply-request",
  operation: "applyResult",
  sessionID: "apply-session",
  payload: { confirm: "APPLY" },
};

describe("broker apply raw-diff safety checks", () => {
  test("rejects symlink and submodule changes before patch validation", async () => {
    const calls: string[][] = [];
    const ctx = makeApplyContext(
      [
        ":000000 120000 0000000000000000000000000000000000000000 111111111111 A\topenspec/link",
        ":000000 160000 0000000000000000000000000000000000000000 222222222222 A\topenspec/submodule",
      ].join("\n") + "\n",
      calls,
    );

    await expect(buildApplyResultOp(ctx)(applyRequest)).rejects.toThrow(/unsafe symlink\/submodule/);
    expect(calls.some((argv) => argv.includes("--raw"))).toBe(true);
    expect(calls.some((argv) => argv.includes("apply"))).toBe(false);
  });

  test("rejects malformed raw metadata before patch validation", async () => {
    const calls: string[][] = [];
    const ctx = makeApplyContext("not a raw diff\n", calls);

    await expect(buildApplyResultOp(ctx)(applyRequest)).rejects.toThrow(/raw metadata malformed/);
    expect(calls.some((argv) => argv.includes("apply"))).toBe(false);
  });
});
