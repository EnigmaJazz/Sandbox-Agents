import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { divergenceIndexPathFor } from "../src/artifacts.ts";
import { defaultConfig } from "../src/config.ts";
import { buildApplyResultOp, buildKeepResultOp, buildPrepareResultOp, type OpContext } from "../src/service.ts";
import type { BrokerRequestEnvelope, SessionRecord, SessionState } from "../src/types.ts";

function makeApplyContext(
  rawDiff: string,
  calls: string[][],
  patchStdout = "",
  stateDir = "/tmp/opencode-sandbox-apply-test",
  onGitAdd?: () => void,
): OpContext {
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
    // applyResult clears workerName + sets DESTROYED only after a CONFIRMED
    // release (Tier 2 item 15); the fake store needs the same mutation seam.
    touch: (_sessionID: string, patch: Partial<SessionRecord> = {}) => {
      record = { ...record, ...patch };
      return record;
    },
    transition: (_sessionID: string, from: SessionState, to: SessionState, patch: Partial<SessionRecord> = {}) => {
      if (record.state !== from) throw new Error(`unexpected state ${record.state}, expected ${from}`);
      record = { ...record, ...patch, state: to };
      return record;
    },
  };

  // Model the byte cap and overflow flag the REAL spawn boundary emits so an
  // over-cap output is refused rather than silently completed (Tier 4 item 58).
  const ok = (stdout = "", opts?: { maxOutputBytes?: number }) => {
    const cap = opts?.maxOutputBytes ?? Number.POSITIVE_INFINITY;
    const bytes = Buffer.byteLength(stdout, "utf8");
    return {
      status: 0,
      stdout: bytes > cap ? Buffer.from(stdout, "utf8").subarray(0, cap).toString("utf8") : stdout,
      stderr: "",
      timedOut: false,
      outputTruncated: bytes > cap,
      stderrTruncated: false,
    };
  };

  return {
    config: defaultConfig({
      stateDir,
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
      spawn: async (argv: string[], opts?: { maxOutputBytes?: number }) => {
        calls.push(argv);
        if (argv.includes("add")) {
          onGitAdd?.();
          return ok("", opts);
        }
        if (argv.includes("ls-files")) return ok("100644 base 0\topenspec/link\n", opts);
        if (argv.includes("ls-tree")) return ok("100644 blob base\topenspec/link\n", opts);
        if (argv.includes("--name-only")) return ok("openspec/link\u0000", opts);
        if (argv.includes("--raw")) return ok(rawDiff, opts);
        if (argv.includes("diff")) return ok(patchStdout, opts);
        return ok("", opts);
      },
    },
  } as unknown as OpContext;
}

/**
 * Capture the plain preview artifact's bytes at the moment the real
 * `git apply` runs (not the `--check` dry run), before any GC can remove it.
 */
function capturePreviewAtApply(
  ctx: OpContext,
  stateDir: string,
): { get: () => string | undefined } {
  const original = ctx.git.spawn;
  let captured: string | undefined;
  let called = false;
  ctx.git.spawn = async (argv: string[]) => {
    if (argv.includes("apply") && !argv.includes("--check")) {
      called = true;
      captured = readFileSync(
        join(stateDir, "apply-preview", "apply-session.diff"),
        "utf8",
      );
    }
    return original(argv);
  };
  return { get: () => (called ? captured : undefined) };
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

  test("applies deltas larger than the configured review cap when the complete artifact exists", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "apply-over-limit-"));
    try {
      const calls: string[][] = [];
      const largePatch = Array.from({ length: 1000 }, (_, i) => `+line ${i}`).join("\n") + "\n";
      const ctx = makeApplyContext("", calls, largePatch, stateDir);
      const atApply = capturePreviewAtApply(ctx, stateDir);
      const result = (await buildApplyResultOp(ctx)(applyRequest)) as {
        applied?: boolean;
        applyPreview?: { previewTruncated?: boolean; preview?: string; totalLines?: number };
        applyPreviewFiles?: { plain?: string; ansi?: string };
      };
      expect(result).toMatchObject({ applied: true });
      expect(calls.some((argv) => argv.includes("apply"))).toBe(true);
      // The approval metadata must be bounded even when the applied delta is not:
      // exact counts, a truncation marker, and a capped preview.
      expect(result.applyPreview?.previewTruncated).toBe(true);
      expect(result.applyPreview?.totalLines).toBe(1001);
      expect(result.applyPreview?.preview?.split("\n").length).toBe(401);
      // Both stable artifact paths are surfaced in the apply result, and the
      // complete diff (not the bounded preview) was on disk when `git apply`
      // ran — the approval was never blind.
      expect(result.applyPreviewFiles?.plain).toBe(
        join(stateDir, "apply-preview", "apply-session.diff"),
      );
      expect(result.applyPreviewFiles?.ansi).toBe(
        join(stateDir, "apply-preview", "apply-session.ansi.diff"),
      );
      expect(atApply.get()).toBe(largePatch);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("applies a delta at or under the preview cap unchanged", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "apply-under-limit-"));
    try {
      const calls: string[][] = [];
      const smallPatch = "+added line\n";
      const ctx = makeApplyContext("", calls, smallPatch, stateDir);
      const atApply = capturePreviewAtApply(ctx, stateDir);
      const result = (await buildApplyResultOp(ctx)(applyRequest)) as {
        applied?: boolean;
        applyPreview?: { previewTruncated?: boolean; totalLines?: number };
        applyPreviewFiles?: { plain?: string };
      };
      expect(result).toMatchObject({ applied: true });
      expect(calls.some((argv) => argv.includes("apply"))).toBe(true);
      expect(result.applyPreview?.previewTruncated).toBe(false);
      expect(atApply.get()).toBe(smallPatch);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("refuses when the complete preview artifact cannot be written", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "apply-no-preview-"));
    try {
      // A regular file where the apply-preview DIRECTORY must be makes the
      // artifact write fail closed. The complete delta is then unavailable to
      // the reviewer, so the apply must be refused before any mutation.
      writeFileSync(join(stateDir, "apply-preview"), "not a directory");
      const calls: string[][] = [];
      const ctx = makeApplyContext("", calls, "+added line\n", stateDir);

      await expect(buildApplyResultOp(ctx)(applyRequest)).rejects.toThrow(
        /apply-preview artifact unavailable/,
      );
      // No apply ran, the result ref is retained, and the state is back to
      // RESULT_READY so the reviewer can re-inspect and retry.
      expect(calls.some((argv) => argv.includes("apply"))).toBe(false);
      expect(ctx.store.get("apply-session")?.state).toBe("RESULT_READY");
      expect(ctx.store.get("apply-session")?.resultRef).toBe(
        "refs/opencode-sandbox/result/apply-session",
      );
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// S16 divergence temp index hygiene
// ---------------------------------------------------------------------------

describe("hostDivergence stale temp index", () => {
  test("a stale divergence index is unlinked before staging and apply still succeeds", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "apply-stale-index-"));
    try {
      const stale = divergenceIndexPathFor(stateDir, "apply-session");
      mkdirSync(join(stateDir, "tmp"), { recursive: true });
      writeFileSync(stale, "stale-index-bytes");
      let staleAtAdd: boolean | undefined;
      const calls: string[][] = [];
      const ctx = makeApplyContext("", calls, "", stateDir, () => {
        staleAtAdd = existsSync(stale);
      });

      const result = (await buildApplyResultOp(ctx)(applyRequest)) as {
        applied?: boolean;
      };

      expect(result).toMatchObject({ applied: true });
      // The stale file must be gone BEFORE `git add -A`, not merely cleaned up
      // afterwards by the finally block, so it can never be reused as the
      // staging index.
      expect(staleAtAdd).toBe(false);
      expect(existsSync(stale)).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T5: a successful export releases the worker while the result stays usable
// ---------------------------------------------------------------------------

function makePrepareReleaseContext(): {
  ctx: OpContext;
  record: () => SessionRecord;
  stopped: string[];
  removed: string[];
  stateDir: string;
  sessionID: string;
} {
  const stateDir = mkdtempSync(join(tmpdir(), "prepare-release-"));
  const sessionID = "prepare-release";
  let record: SessionRecord = {
    sessionID,
    projectID: "repo",
    state: "SANDBOX_ACTIVE",
    workerName: `worker-${sessionID}`,
    workerState: "ACTIVE",
    baselineRef: `refs/opencode-sandbox/baseline/${sessionID}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const stopped: string[] = [];
  const removed: string[] = [];
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "", timedOut: false });
  // One stable 40-hex identity is both the worker HEAD and the exported commit.
  const PROOF = "a".repeat(40);

  const ctx = {
    config: defaultConfig({ stateDir, projects: [{ id: "repo", path: "/repo" }] }),
    store: {
      get: () => record,
      list: () => [record],
      touch: (_id: string, patch: Partial<SessionRecord> = {}) => {
        record = { ...record, ...patch };
        return record;
      },
      transition: (
        _id: string,
        from: SessionState,
        to: SessionState,
        patch: Partial<SessionRecord> = {},
      ) => {
        if (record.state !== from) {
          throw new Error(`unexpected state ${record.state}, expected ${from}`);
        }
        record = { ...record, ...patch, state: to };
        return record;
      },
    },
    adapter: {
      // The removal proof is modelled: the worker HEAD and the host-side
      // exported commit are the same stable identity for a just-exported result.
      exec: async (_worker: string, argv: string[] = []) =>
        argv[0] === "git" && argv[1] === "rev-parse" ? ok(`${PROOF}\n`) : ok(),
      copyOut: async () => undefined,
      stop: async (name: string) => {
        stopped.push(name);
      },
      remove: async (name: string) => {
        removed.push(name);
      },
    },
    budget: {
      perWorkerCpu: 2,
      perWorkerMemBytes: 2 * 1024 * 1024 * 1024,
      maxAggregateCpu: 8,
      maxAggregateMemBytes: 8 * 1024 * 1024 * 1024,
      maxWorkers: 4,
      hostReservedCpu: 4,
      hostReservedMemBytes: 8 * 1024 * 1024 * 1024,
    },
    resources: { cpuCount: 16, totalMemBytes: 32 * 1024 * 1024 * 1024 },
    pool: {
      allocations: [{ cpu: 2, memBytes: 2 * 1024 * 1024 * 1024, sessionID }],
    },
    hostRead: { has: () => false },
    logger: {},
    git: {
      runnerMode: "planned",
      // A result ref resolves to the exported commit the worker HEAD reports.
      spawn: async (argv: string[]) =>
        argv.includes("rev-parse") ? ok(`${PROOF}\n`) : ok(),
    },
  } as unknown as OpContext;

  return { ctx, record: () => record, stopped, removed, stateDir, sessionID };
}

describe("prepareResult releases the host-side result's worker", () => {
  test("a successful export releases the worker, keeps RESULT_READY, and retain still works", async () => {
    const h = makePrepareReleaseContext();
    try {
      const prepared = (await buildPrepareResultOp(h.ctx)({
        version: 1,
        id: "prepare-release",
        operation: "prepareResult",
        sessionID: h.sessionID,
        payload: {},
      } as BrokerRequestEnvelope)) as { resultRef: string; state: string };

      expect(prepared.state).toBe("RESULT_READY");
      expect(h.stopped).toEqual([`worker-${h.sessionID}`]);
      expect(h.removed).toEqual([`worker-${h.sessionID}`]);
      expect(h.ctx.pool.allocations).toEqual([]);

      const released = h.record();
      expect(released.state).toBe("RESULT_READY");
      expect(released.resultRef).toBe(prepared.resultRef);
      expect(released.workerName).toBeUndefined();
      expect(released.workerState).toBe("DESTROYED");

      // Positive control: the retained result is still usable after release.
      // `keepResult` is absent from ALLOWED_PAYLOAD_KEYS (pre-existing gap), so
      // label the confirm-gated envelope `applyResult` to admit the payload and
      // exercise the keep branch, as worker-release-outcome.test.ts does.
      const kept = (await buildKeepResultOp(h.ctx)({
        version: 1,
        id: "keep-after-prepare",
        operation: "applyResult",
        sessionID: h.sessionID,
        payload: { confirm: "KEEP" },
      } as BrokerRequestEnvelope)) as { retained?: boolean; resultRef?: string };

      expect(kept.retained).toBe(true);
      expect(kept.resultRef).toBe(prepared.resultRef);
      expect(h.record().state).toBe("RETAINED");
    } finally {
      rmSync(h.stateDir, { recursive: true, force: true });
    }
  });
});

describe("a re-finish of RESULT_READY without a worker reuses the durable result", () => {
  const request = (sessionID: string): BrokerRequestEnvelope => ({
    version: 1,
    id: `prepare-again-${sessionID}`,
    operation: "prepareResult",
    sessionID,
    payload: {},
  } as BrokerRequestEnvelope);

  test("returns the existing result ref with no adapter call (imported: false)", async () => {
    const h = makePrepareReleaseContext();
    try {
      const first = (await buildPrepareResultOp(h.ctx)(request(h.sessionID))) as {
        resultRef: string;
        state: string;
        imported: boolean;
      };
      // Positive control for the state this test depends on: the export landed
      // and its worker was released, so the record has no live worker.
      expect(first.imported).toBe(true);
      expect(h.record().state).toBe("RESULT_READY");
      expect(h.record().workerName).toBeUndefined();

      let execCalls = 0;
      h.ctx.adapter.exec = async () => {
        execCalls++;
        return { status: 0, stdout: "", stderr: "", timedOut: false };
      };
      const again = (await buildPrepareResultOp(h.ctx)(request(h.sessionID))) as {
        resultRef: string;
        state: string;
        imported: boolean;
      };

      expect(again).toEqual({
        resultRef: first.resultRef,
        state: "RESULT_READY",
        imported: false,
      });
      // The absence assertion above is only meaningful with this control: a
      // re-export would have issued adapter calls.
      expect(execCalls).toBe(0);
      expect(h.stopped).toEqual([`worker-${h.sessionID}`]);
    } finally {
      rmSync(h.stateDir, { recursive: true, force: true });
    }
  });

  test("positive control: a re-finish with a live worker still re-exports", async () => {
    const h = makePrepareReleaseContext();
    try {
      await buildPrepareResultOp(h.ctx)(request(h.sessionID));
      // Model the ensureWorker that re-creates a worker on demand.
      h.ctx.store.touch(h.sessionID, {
        workerName: `worker-${h.sessionID}`,
        workerState: "ACTIVE",
      });

      let execCalls = 0;
      const PROOF = "a".repeat(40);
      h.ctx.adapter.exec = async (_worker: string, argv: string[] = []) => {
        execCalls++;
        // Keep the removal proof truthful: HEAD still equals the exported tip.
        return argv[0] === "git" && argv[1] === "rev-parse"
          ? { status: 0, stdout: `${PROOF}\n`, stderr: "", timedOut: false }
          : { status: 0, stdout: "", stderr: "", timedOut: false };
      };
      const again = (await buildPrepareResultOp(h.ctx)(request(h.sessionID))) as {
        resultRef: string;
        state: string;
        imported: boolean;
      };

      expect(again).toEqual({
        resultRef: "refs/opencode-sandbox/result/prepare-release",
        state: "RESULT_READY",
        imported: true,
      });
      expect(execCalls).toBeGreaterThan(0);
      // The re-export released the worker it just used.
      expect(h.stopped).toEqual([
        `worker-${h.sessionID}`,
        `worker-${h.sessionID}`,
      ]);
    } finally {
      rmSync(h.stateDir, { recursive: true, force: true });
    }
  });
});
