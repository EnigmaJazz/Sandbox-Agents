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
import { buildApplyResultOp, type OpContext } from "../src/service.ts";
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
    transition: (_sessionID: string, from: SessionState, to: SessionState, patch: Partial<SessionRecord> = {}) => {
      if (record.state !== from) throw new Error(`unexpected state ${record.state}, expected ${from}`);
      record = { ...record, ...patch, state: to };
      return record;
    },
  };

  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "", timedOut: false });

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
      spawn: async (argv: string[]) => {
        calls.push(argv);
        if (argv.includes("add")) {
          onGitAdd?.();
          return ok();
        }
        if (argv.includes("ls-files")) return ok("100644 base 0\topenspec/link\n");
        if (argv.includes("ls-tree")) return ok("100644 blob base\topenspec/link\n");
        if (argv.includes("--name-only")) return ok("openspec/link\u0000");
        if (argv.includes("--raw")) return ok(rawDiff);
        if (argv.includes("diff")) return ok(patchStdout);
        return ok();
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
