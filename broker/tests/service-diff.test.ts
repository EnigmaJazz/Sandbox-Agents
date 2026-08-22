import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { buildDiffOp, type OpContext } from "../src/service.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

function makeDiffContext(calls: string[][]): OpContext {
  const record: SessionRecord = {
    sessionID: "diff-session",
    state: "SANDBOX_ACTIVE",
    workerName: "worker-diff-session",
    workerState: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  return {
    store: { get: () => record },
    adapter: {
      exec: async (_worker: string, argv: string[]) => {
        calls.push(argv);
        if (argv.includes("--stat")) return { status: 0, stdout: "1 file changed", stderr: "", timedOut: false };
        if (argv.includes("--name-only")) {
          return { status: 0, stdout: "openspec/spec.md\u0000", stderr: "", timedOut: false };
        }
        return { status: 0, stdout: "", stderr: "", timedOut: false };
      },
    },
  } as unknown as OpContext;
}

function makeRetainedDiffContext(calls: string[]): OpContext {
  const record: SessionRecord = {
    sessionID: "retained-session",
    projectID: "repo",
    state: "RESULT_READY",
    workerName: "worker-retained-session",
    workerState: "ACTIVE",
    baselineRef: "refs/opencode-sandbox/baseline/retained-session",
    resultRef: "refs/opencode-sandbox/result/retained-session",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "", timedOut: false });
  return {
    config: defaultConfig({ projects: [{ id: "repo", path: "/repo" }] }),
    store: { get: () => record },
    git: {
      spawn: async (argv: string[]) => {
        calls.push(argv.join(" "));
        if (argv.includes("--stat")) return ok("1 file changed");
        if (argv.includes("--name-only")) return ok("openspec/spec.md\u0000");
        return ok("openspec diff");
      },
    },
  } as unknown as OpContext;
}

const diffRequest: BrokerRequestEnvelope = {
  version: 1,
  id: "diff-request",
  operation: "diff",
  sessionID: "diff-session",
};

describe("broker diff metadata", () => {
  test("returns complete changed paths for the approval decision", async () => {
    const calls: string[][] = [];
    const result = (await buildDiffOp(makeDiffContext(calls))(diffRequest)) as Record<string, unknown>;

    expect(result.changedPaths).toEqual(["openspec/spec.md"]);
    expect(result.changedPathsComplete).toBe(true);
  });

  test("discovers paths with no rename detection and NUL framing", async () => {
    const calls: string[][] = [];
    await buildDiffOp(makeDiffContext(calls))(diffRequest);

    expect(calls).toContainEqual([
      "git",
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      "refs/opencode-sandbox/baseline/diff-session",
      "HEAD",
      "--",
      ".",
    ]);
  });

  test("retained metadata compares the imported result ref, not active worker HEAD", async () => {
    const calls: string[] = [];
    const request: BrokerRequestEnvelope = {
      ...diffRequest,
      sessionID: "retained-session",
      payload: { mode: "retained" },
    };

    await buildDiffOp(makeRetainedDiffContext(calls))(request);

    expect(calls).toContain(
      "git diff --stat refs/opencode-sandbox/baseline/retained-session refs/opencode-sandbox/result/retained-session",
    );
    expect(calls).not.toContain(
      "git diff --stat refs/opencode-sandbox/baseline/retained-session HEAD",
    );
  });
});
