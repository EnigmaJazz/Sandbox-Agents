/**
 * Real-filesystem tests for the broker-owned review-run store (slice U1b-1).
 *
 * Every case drives REAL files and directories: a string-only fake cannot
 * exercise directory/file modes, O_EXCL, rename or fsync — the vacuous-test
 * defect this suite exists to avoid. Temp bases deliberately live under
 * /var/tmp (or, when it is unavailable, the home directory) because a store
 * root under the effective $TMPDIR is itself a refusal under test.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_REVIEW_RUN_CAPS,
  ReviewRunCapError,
  ReviewRunEvidenceError,
  ReviewRunFileCapError,
  ReviewRunIdError,
  ReviewRunQuotaError,
  ReviewRunStore,
  ReviewRunStoreDeniedPrefixError,
  ReviewRunStoreInProjectError,
  ReviewRunStoreInTmpError,
  assertReviewRunId,
  generateRunId,
  publishArtifactAtomic,
  type ReviewRunCaps,
  type ReviewRunStoreOptions,
} from "../src/review-run.ts";

const cleanup: string[] = [];

/**
 * A writable base that is NOT the effective $TMPDIR and NOT a project tree.
 * /var/tmp is the standard such location on this host; the home directory is
 * the fallback. Raises rather than silently degrading so a missing base is a
 * loud test-environment failure, never a vacuous pass.
 */
function outsideTmpBase(): string {
  for (const candidate of ["/var/tmp", homedir()]) {
    let real: string;
    try {
      real = realpathSync(candidate);
      accessSync(real, constants.W_OK);
    } catch {
      continue;
    }
    if (
      real === realpathSync(tmpdir()) ||
      real.startsWith(realpathSync(tmpdir()) + "/") ||
      realpathSync(tmpdir()).startsWith(real + "/")
    ) {
      continue;
    }
    return real;
  }
  throw new Error("no writable test base outside $TMPDIR is available");
}

function tempBase(prefix: string): string {
  const dir = mkdtempSync(join(outsideTmpBase(), `rr-${prefix}-`));
  cleanup.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

interface StoreOverrides {
  root?: string;
  projectRoot?: string;
  deniedPrefixes?: string[];
  caps?: Partial<ReviewRunCaps>;
}

/** Build a store whose root and project both sit outside $TMPDIR. */
function makeStore(overrides: StoreOverrides = {}): ReviewRunStore {
  const opts: ReviewRunStoreOptions = {
    root: overrides.root ?? join(tempBase("store"), "review-runs"),
    projectRoot: overrides.projectRoot ?? tempBase("project"),
    deniedPrefixes: overrides.deniedPrefixes,
    caps: overrides.caps,
  };
  return new ReviewRunStore(opts);
}

function catchError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw, but it returned");
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("run identity grammar", () => {
  test("generateRunId is 32 lowercase hex characters and validates", () => {
    const runId = generateRunId();
    expect(runId).toMatch(/^[0-9a-f]{32}$/);
    expect(() => assertReviewRunId(runId)).not.toThrow();
    expect(generateRunId()).not.toBe(runId);
  });

  test("a caller-supplied runId that is not the exact grammar is rejected, never sanitized", () => {
    const bad: unknown[] = [
      "",
      "0123456789abcdef0123456789ABCDEF",
      "0123456789abcdef0123456789abcde",
      "0123456789abcdef0123456789abcdef0",
      "0123456789abcdef0123456789abcdeg",
      "123e4567-e89b-12d3-a456-426614174000",
      "../../escape",
      "name/with/slash",
      42,
      null,
      undefined,
    ];
    for (const value of bad) {
      const err = catchError(() => assertReviewRunId(value));
      expect(err).toBeInstanceOf(ReviewRunIdError);
    }
  });
});

describe("store-root refusals", () => {
  test("a store root inside the project root is refused, naming the path", () => {
    const project = tempBase("project");
    const root = join(project, "store");
    const err = catchError(() => new ReviewRunStore({ root, projectRoot: project }));
    expect(err).toBeInstanceOf(ReviewRunStoreInProjectError);
    expect(err.message).toContain(realpathSync(project));
    expect(err.message).toContain("store");
  });

  test("a store root under $TMPDIR is refused, naming the path", () => {
    const project = join(tempBase("project"), "tree");
    // tempBase() is outside $TMPDIR; build an explicit in-$TMPDIR path.
    const inTmp = join(tmpdir(), `rr-tmp-${process.pid}-${Date.now()}`);
    const err = catchError(() => new ReviewRunStore({ root: inTmp, projectRoot: project }));
    expect(err).toBeInstanceOf(ReviewRunStoreInTmpError);
    expect(err.message).toContain(realpathSync(tmpdir()));
    expect(err.message).toContain("$TMPDIR");
  });

  test("a store root under an operator-denied prefix is refused, naming the prefix", () => {
    const denied = tempBase("denied");
    const root = join(denied, "store");
    const err = catchError(
      () =>
        new ReviewRunStore({
          root,
          projectRoot: tempBase("project"),
          deniedPrefixes: [denied],
        }),
    );
    expect(err).toBeInstanceOf(ReviewRunStoreDeniedPrefixError);
    expect(err.message).toContain(realpathSync(denied));
  });

  test("every refusal names the offending path, and a sibling name is not a false positive", () => {
    const parent = tempBase("parent");
    const project = join(parent, "proj");
    const root = join(parent, "proj-backup", "store");
    // "proj-backup" shares the string prefix "proj" but is NOT inside it: a
    // bare startsWith() would wrongly refuse. Canonical containment must accept.
    const store = new ReviewRunStore({ root, projectRoot: project });
    expect(store.root).toBe(join(realpathSync(parent), "proj-backup", "store"));
  });
});

describe("caps and quotas", () => {
  test("an artifact over the per-file cap is refused naming the cap and the observed size", () => {
    const store = makeStore({ caps: { maxFileBytes: 4 } });
    const writer = store.createRun("sess-filecap");
    const err = catchError(() => writer.addArtifact("payload.bin", Buffer.alloc(5, 0x61)));
    expect(err).toBeInstanceOf(ReviewRunFileCapError);
    expect(err.message).toContain("5");
    expect(err.message).toContain("4");
    expect(readdirSync(writer.runDir)).not.toContain("payload.bin");
  });

  test("an artifact exactly at the per-file cap is accepted, byte-for-byte", () => {
    const store = makeStore({ caps: { maxFileBytes: 4 } });
    const writer = store.createRun("sess-exact");
    const artifact = writer.addArtifact("exact.bin", Buffer.alloc(4, 0x61));
    expect(artifact.bytes).toBe(4);
    expect(readFileSync(join(writer.runDir, "exact.bin")).equals(Buffer.alloc(4, 0x61))).toBe(true);
  });

  test("a publication that would exceed the per-run cap is refused naming the cap and the total", () => {
    const store = makeStore({ caps: { maxBytes: 10, maxFileBytes: 8 } });
    const writer = store.createRun("sess-runcap");
    writer.addArtifact("first.bin", Buffer.alloc(6, 0x61));
    const err = catchError(() => writer.addArtifact("second.bin", Buffer.alloc(6, 0x62)));
    expect(err).toBeInstanceOf(ReviewRunCapError);
    expect(err.message).toContain("12");
    expect(err.message).toContain("10");
    expect(readdirSync(writer.runDir)).not.toContain("second.bin");
  });

  test("a session at its run quota is refused; a different session is not", () => {
    const store = makeStore({ caps: { maxPerSession: 2 } });
    store.createRun("sess-quota");
    store.createRun("sess-quota");
    const err = catchError(() => store.createRun("sess-quota"));
    expect(err).toBeInstanceOf(ReviewRunQuotaError);
    expect(err.message).toContain("2");
    expect(store.countRunsForSession("sess-quota")).toBe(2);
    expect(() => store.createRun("sess-other")).not.toThrow();
  });

  test("the default caps are 8 MiB per run, 4 MiB per file and 8 runs per session", () => {
    expect(DEFAULT_REVIEW_RUN_CAPS).toEqual({
      maxBytes: 8 * 1024 * 1024,
      maxFileBytes: 4 * 1024 * 1024,
      maxPerSession: 8,
    });
  });
});

describe("atomic publication invariant", () => {
  test("a failure between temp-write and rename leaves no artifact and no temp file", () => {
    const dir = tempBase("atomic");
    const err = catchError(() =>
      publishArtifactAtomic(dir, "payload.bin", Buffer.from("partial"), {
        beforeRename: () => {
          throw new Error("simulated failure between temp-write and rename");
        },
      }),
    );
    expect(err.message).toBe("simulated failure between temp-write and rename");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a published artifact is byte-identical to its input, including non-ASCII", () => {
    const dir = tempBase("identical");
    const content = "héllo wörld — €5\n日本語\n";
    const input = Buffer.from(content, "utf8");
    const artifact = publishArtifactAtomic(dir, "note.txt", input);
    const onDisk = readFileSync(join(dir, "note.txt"));
    expect(onDisk.equals(input)).toBe(true);
    expect(artifact.bytes).toBe(input.byteLength);
    // More UTF-8 bytes than UTF-16 units: a String.length cap would drift.
    expect(artifact.bytes).toBeGreaterThan(content.length);
    expect(artifact.sha256).toBe(createHash("sha256").update(input).digest("hex"));
  });

  test("publication writes a real regular file with mode 0600 and no temp remnant", () => {
    const dir = tempBase("mode");
    publishArtifactAtomic(dir, "note.txt", "x");
    const names = readdirSync(dir);
    expect(names).toEqual(["note.txt"]);
    expect(lstatSync(join(dir, "note.txt")).isFile()).toBe(true);
    expect(modeOf(join(dir, "note.txt"))).toBe(0o600);
  });
});

describe("run metadata", () => {
  test("metadata records session, evidence ids and per-artifact sha256/bytes", () => {
    const store = makeStore();
    const baseObjectId = "a".repeat(40);
    const headObjectId = "b".repeat(64);
    const writer = store.createRun("sess-meta", { baseObjectId, headObjectId });
    const payload = Buffer.from("héllo\n", "utf8");
    writer.addArtifact("payload.txt", payload);
    writer.publish();

    const raw = readFileSync(join(writer.runDir, "metadata.json"));
    expect(modeOf(join(writer.runDir, "metadata.json"))).toBe(0o600);
    const meta = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    expect(meta.runId).toBe(writer.record.runId);
    expect(meta.sessionID).toBe("sess-meta");
    expect(meta.state).toBe("published");
    expect(meta.baseObjectId).toBe(baseObjectId);
    expect(meta.headObjectId).toBe(headObjectId);
    expect(typeof meta.createdAt).toBe("string");
    expect(meta.artifacts).toEqual([
      {
        name: "payload.txt",
        bytes: payload.byteLength,
        sha256: createHash("sha256").update(payload).digest("hex"),
      },
    ]);
    // 7 UTF-8 bytes for 6 UTF-16 units: byteLength, never String.length.
    expect(payload.byteLength).toBe(7);
  });

  test("a caller-supplied evidence id outside the object-id grammar is refused", () => {
    const store = makeStore();
    const err = catchError(() => store.createRun("sess-badevidence", { baseObjectId: "HEAD" }));
    expect(err).toBeInstanceOf(ReviewRunEvidenceError);
    expect(err.message).toContain("baseObjectId");
  });
});

describe("store ownership modes", () => {
  test("root, session and run dirs are 0700 and files 0600 even under a hostile umask", () => {
    const store = makeStore();
    const previous = process.umask(0o777);
    try {
      const writer = store.createRun("sess-modes");
      writer.addArtifact("data.bin", Buffer.from("x"));
      writer.publish();
      expect(modeOf(store.root)).toBe(0o700);
      expect(modeOf(join(store.root, "sess-modes"))).toBe(0o700);
      expect(modeOf(writer.runDir)).toBe(0o700);
      expect(modeOf(join(writer.runDir, "data.bin"))).toBe(0o600);
      expect(modeOf(join(writer.runDir, "metadata.json"))).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });
});
