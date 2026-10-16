import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { buildDiffOp, type OpContext } from "../src/service.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

/** Byte-accurate cap for every fake spawn in this file (Tier 4 item 58). */
function capped(text: string, cap: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= cap) return { text, truncated: false };
  return {
    text: Buffer.from(text, "utf8").subarray(0, cap).toString("utf8"),
    truncated: true,
  };
}

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
    config: defaultConfig({
      stateDir: mkdtempSync(join(tmpdir(), "service-diff-")),
      projects: [{ id: "repo", path: "/repo" }],
    }),
    store: { get: () => record },
    adapter: {
      exec: async (_worker: string, argv: string[], opts?: { maxOutputBytes?: number }) => {
        calls.push(argv);
        const cap = opts?.maxOutputBytes ?? Number.POSITIVE_INFINITY;
        const respond = (stdout: string) => {
          const out = capped(stdout, cap);
          return {
            status: 0,
            stdout: out.text,
            stderr: "",
            timedOut: false,
            outputTruncated: out.truncated,
            stderrTruncated: false,
          };
        };
        if (argv.includes("--stat")) return respond("1 file changed");
        if (argv.includes("--name-only")) {
          return respond("openspec/spec.md\u0000");
        }
        return respond("");
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

  const ok = (stdout = "", opts?: { maxOutputBytes?: number }) => {
    const out = capped(stdout, opts?.maxOutputBytes ?? Number.POSITIVE_INFINITY);
    return {
      status: 0,
      stdout: out.text,
      stderr: "",
      timedOut: false,
      outputTruncated: out.truncated,
      stderrTruncated: false,
    };
  };
  return {
    config: defaultConfig({ projects: [{ id: "repo", path: "/repo" }] }),
    store: { get: () => record },
    git: {
      spawn: async (argv: string[], opts?: { maxOutputBytes?: number }) => {
        calls.push(argv.join(" "));
        if (argv.includes("--stat")) return ok("1 file changed", opts);
        if (argv.includes("--name-only")) return ok("openspec/spec.md\u0000", opts);
        return ok("openspec diff", opts);
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
      "--cached",
      "--name-only",
      "--no-renames",
      "-z",
      "refs/opencode-sandbox/baseline/diff-session",
      "--",
      ".",
      ":(exclude).broker-tmp",
      ":(exclude)*.bundle",
    ]);
    expect(calls).toContainEqual([
      "git",
      "read-tree",
      "refs/opencode-sandbox/baseline/diff-session",
    ]);
    expect(calls).toContainEqual([
      "git",
      "add",
      "-A",
      "--",
      ".",
      ":(exclude).broker-tmp",
      ":(exclude)*.bundle",
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
