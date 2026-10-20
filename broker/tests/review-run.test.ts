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
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_REVIEW_RUN_CAPS,
  ReviewRunCapError,
  ReviewRunError,
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
  DEFAULT_REVIEW_RUN_MAX_RUNS,
  DEFAULT_REVIEW_RUN_TTL_MS,
  ReviewHelperDigestMismatchError,
  ReviewHelperMissingError,
  ReviewHelperNotRegularError,
  ReviewHelperUnconfiguredError,
  ReviewRunArtifactCapError,
  ReviewRunArtifactEscapeError,
  ReviewRunArtifactNotFoundError,
  ReviewRunArtifactNotRegularError,
  ReviewRunArtifactSymlinkError,
  ReviewRunOwnershipError,
  assertPinnedReviewHelper,
  assertRunOwnership,
  pruneReviewRuns,
  readRunArtifact,
  recoverInterruptedRuns,
  type ReviewRunCaps,
  type ReviewRunStoreOptions,
} from "../src/review-run.ts";
import { ConfigError, defaultConfig } from "../src/config.ts";

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

function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** True when the path itself exists (does not follow a final symlink). */
function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
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

describe("reserved run-record name", () => {
  test("an artifact named exactly like the run record is refused, naming both names", () => {
    const store = makeStore();
    const writer = store.createRun("sess-reserved");
    const err = catchError(() => writer.addArtifact("metadata.json", "hijack"));
    expect(err).toBeInstanceOf(ReviewRunError);
    expect((err as ReviewRunError).code).toBe("review_run_artifact_name_reserved");
    expect(err.message).toContain("metadata.json");
    // Nothing was published: the run directory still holds only the record.
    expect(readdirSync(writer.runDir)).toEqual(["metadata.json"]);
  });

  test("a case variant of the reserved name is refused (case-insensitive filesystems)", () => {
    const store = makeStore();
    const writer = store.createRun("sess-reserved-case");
    const err = catchError(() => writer.addArtifact("Metadata.json", "hijack"));
    expect(err).toBeInstanceOf(ReviewRunError);
    expect((err as ReviewRunError).code).toBe("review_run_artifact_name_reserved");
    expect(err.message).toContain("Metadata.json");
    expect(err.message).toContain("metadata.json");
  });

  test("after a reserved-name refusal the run record still matches the files on disk", () => {
    const store = makeStore();
    const writer = store.createRun("sess-reserved-intact");
    writer.addArtifact("payload.bin", Buffer.from("real"));
    catchError(() => writer.addArtifact("metadata.json", Buffer.from("hijack")));
    writer.publish();

    const names = readdirSync(writer.runDir).sort();
    expect(names).toEqual(["metadata.json", "payload.bin"]);
    const meta = JSON.parse(readFileSync(join(writer.runDir, "metadata.json"), "utf8")) as {
      artifacts: { name: string }[];
    };
    const recorded = meta.artifacts.map((a) => a.name);
    expect(recorded).toEqual(["payload.bin"]);
    expect(recorded).toEqual(names.filter((n) => n !== "metadata.json"));
  });

  test("a name that merely contains the reserved name is accepted (no includes() false positive)", () => {
    const store = makeStore();
    const writer = store.createRun("sess-reserved-contains");
    expect(() => writer.addArtifact("metadata.json.bak", "x")).not.toThrow();
    expect(() => writer.addArtifact("mymetadata.json", "y")).not.toThrow();
    expect(readdirSync(writer.runDir).sort()).toEqual([
      "metadata.json",
      "metadata.json.bak",
      "mymetadata.json",
    ]);
  });
});

describe("store ownership modes", () => {
  test("read-only stores refuse mutations without changing the store or project tree", () => {
    const writable = makeStore();
    const writer = writable.createRun("sess-read-only");
    writer.addArtifact("data.bin", "before");
    writer.publish();
    const store = ReviewRunStore.readOnly({ root: writable.root, projectRoot: writable.projectRoot });
    const snapshot = (path: string): string => {
      if (!lstatExists(path)) return "missing";
      const stat = lstatSync(path);
      if (stat.isDirectory()) return readdirSync(path).sort().map((name) => `${name}:${snapshot(join(path, name))}`).join("|");
      return readFileSync(path).toString("base64");
    };
    const before = `${snapshot(store.root)}:${snapshot(store.projectRoot)}`;
    const operations = [
      () => store.createRun("sess-read-only"),
      () => store.addArtifact("sess-read-only", writer.record.runId, "extra.bin", "x"),
      () => store.recordFinalizeProvenance("sess-read-only", writer.record.runId, { phase: "finalize", outcome: "accepted" }),
    ];
    for (const operation of operations) {
      const error = catchError(operation) as ReviewRunError;
      expect(error).toBeInstanceOf(ReviewRunError);
      expect(error.code).toBe("review_run_store_read_only");
    }
    expect(`${snapshot(store.root)}:${snapshot(store.projectRoot)}`).toBe(before);
    expect(store.readRecord("sess-read-only", writer.record.runId).state).toBe("published");
  });

  test("writable stores continue to create, publish, and update runs", () => {
    const store = makeStore();
    const writer = store.createRun("sess-writable");
    writer.addArtifact("data.bin", "before");
    writer.publish();
    store.addArtifact("sess-writable", writer.record.runId, "extra.bin", "after");
    store.recordFinalizeProvenance("sess-writable", writer.record.runId, { phase: "finalize", outcome: "accepted" });
    const record = store.readRecord("sess-writable", writer.record.runId);
    expect(record.state).toBe("published");
    expect(record.artifacts.map((artifact) => artifact.name)).toEqual(["data.bin", "extra.bin"]);
    expect(record.finalizeProvenance?.outcome).toBe("accepted");
  });

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

describe("review-run config knobs", () => {
  test("defaults: no helper pin, a 7-day TTL and a 64-run global bound", () => {
    const cfg = defaultConfig();
    expect(cfg.reviewHelperPath).toBeNull();
    expect(cfg.reviewHelperSha256).toBeNull();
    expect(cfg.reviewRunTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_REVIEW_RUN_TTL_MS).toBe(cfg.reviewRunTtlMs);
    expect(cfg.reviewRunMaxRuns).toBe(64);
    expect(DEFAULT_REVIEW_RUN_MAX_RUNS).toBe(cfg.reviewRunMaxRuns);
  });

  test("a malformed sha256 override is refused with a named config error", () => {
    for (const bad of ["not-a-digest", "ABCDEF", "a".repeat(63), "a".repeat(65), "g".repeat(64)]) {
      const err = catchError(() => defaultConfig({ reviewHelperSha256: bad }));
      expect(err).toBeInstanceOf(ConfigError);
    }
  });

  test("a malformed sha256 env value is refused at parse", () => {
    const previous = process.env.BROKER_REVIEW_HELPER_SHA256;
    process.env.BROKER_REVIEW_HELPER_SHA256 = "NOT-HEX";
    try {
      const err = catchError(() => defaultConfig());
      expect(err).toBeInstanceOf(ConfigError);
    } finally {
      if (previous === undefined) delete process.env.BROKER_REVIEW_HELPER_SHA256;
      else process.env.BROKER_REVIEW_HELPER_SHA256 = previous;
    }
  });

  test("a well-formed sha256 override and path are accepted", () => {
    const digest = "e".repeat(64);
    const cfg = defaultConfig({ reviewHelperPath: "/x/helper", reviewHelperSha256: digest });
    expect(cfg.reviewHelperSha256).toBe(digest);
    expect(cfg.reviewHelperPath).toBe("/x/helper");
  });
});

describe("pinned helper identity", () => {
  function writeHelper(dir: string, name: string, content: string): { path: string; sha: string } {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, content);
    return { path, sha: sha256Hex(content) };
  }

  test("a configured regular file with a matching digest is accepted and returned", () => {
    const base = tempBase("helper-ok");
    const { path, sha } = writeHelper(join(base, "bin"), "helper.js", "console.log(1)\n");
    const verified = assertPinnedReviewHelper({ reviewHelperPath: path, reviewHelperSha256: sha });
    expect(verified.path).toBe(realpathSync(path));
    expect(verified.sha256).toBe(sha);
    expect(verified.bytes).toBe(Buffer.byteLength("console.log(1)\n"));
  });

  test("an unconfigured helper (null path or null digest) is refused", () => {
    const cases: { reviewHelperPath: string | null; reviewHelperSha256: string | null }[] = [
      { reviewHelperPath: null, reviewHelperSha256: "a".repeat(64) },
      { reviewHelperPath: "/nonexistent/helper", reviewHelperSha256: null },
      { reviewHelperPath: null, reviewHelperSha256: null },
    ];
    for (const cfg of cases) {
      const err = catchError(() => assertPinnedReviewHelper(cfg));
      expect(err).toBeInstanceOf(ReviewHelperUnconfiguredError);
    }
  });

  test("a missing helper file is refused", () => {
    const err = catchError(() =>
      assertPinnedReviewHelper({
        reviewHelperPath: join(tempBase("helper-missing"), "absent.js"),
        reviewHelperSha256: "b".repeat(64),
      }),
    );
    expect(err).toBeInstanceOf(ReviewHelperMissingError);
  });

  test.each([
    ["EACCES", "review_helper_unreadable", "not readable"],
    ["EPERM", "review_helper_unreadable", "not readable"],
    ["ENOTDIR", "review_helper_path_component_not_directory", "component that is not a directory"],
    ["EIO", "review_helper_lstat_unexpected", "unexpectedly"],
    [undefined, "review_helper_lstat_unexpected", "unexpectedly"],
  ])("lstat failure %s has its own refusal", (code, expectedCode, phrase) => {
    const path = "/synthetic/helper.js";
    const err = catchError(() => assertPinnedReviewHelper({
      reviewHelperPath: path,
      reviewHelperSha256: "a".repeat(64),
      lstat: () => { throw Object.assign(new Error("synthetic"), { code }); },
    } as never));
    expect(err).toBeInstanceOf(ReviewRunError);
    expect((err as ReviewRunError & { code: string }).code).toBe(expectedCode);
    expect(err.message).toContain(phrase);
    expect(err.message).toContain(path);
    if (code !== undefined && code !== "ENOTDIR") expect(err.message).toContain(code);
  });

  test("ENOTDIR comes from a real regular-file path component", () => {
    const base = tempBase("helper-enotdir");
    const component = join(base, "not-a-directory");
    writeFileSync(component, "file");
    const err = catchError(() => assertPinnedReviewHelper({
      reviewHelperPath: join(component, "helper.js"),
      reviewHelperSha256: "a".repeat(64),
    }));
    expect((err as ReviewRunError & { code: string }).code).toBe("review_helper_path_component_not_directory");
    expect(err.message).toContain(join(component, "helper.js"));
  });

  test("a directory in place of the helper is refused as not a regular file", () => {
    const dir = tempBase("helper-dir");
    const err = catchError(() =>
      assertPinnedReviewHelper({ reviewHelperPath: dir, reviewHelperSha256: "c".repeat(64) }),
    );
    expect(err).toBeInstanceOf(ReviewHelperNotRegularError);
  });

  test("a symlink to a regular helper is refused (symlinks never followed)", () => {
    const base = tempBase("helper-link");
    const target = writeHelper(join(base, "real"), "helper.js", "x");
    const link = join(base, "helper-link.js");
    symlinkSync(target.path, link);
    const err = catchError(() =>
      assertPinnedReviewHelper({ reviewHelperPath: link, reviewHelperSha256: target.sha }),
    );
    expect(err).toBeInstanceOf(ReviewHelperNotRegularError);
  });

  test("a stale digest is refused naming the expected and the observed digest", () => {
    const base = tempBase("helper-stale");
    const { path } = writeHelper(join(base, "bin"), "helper.js", "real bytes\n");
    const expected = "d".repeat(64);
    const err = catchError(() =>
      assertPinnedReviewHelper({ reviewHelperPath: path, reviewHelperSha256: expected }),
    );
    expect(err).toBeInstanceOf(ReviewHelperDigestMismatchError);
    expect(err.message).toContain(expected);
    expect(err.message).toContain(sha256Hex("real bytes\n"));
  });

  test("a valid helper in a package-cache-like directory is NOT used when the config points elsewhere", () => {
    const base = tempBase("helper-cache");
    // A genuine, digest-correct helper sitting exactly where the confined agent
    // can write it (the Systematic package-cache shape).
    const cache = writeHelper(
      join(base, "cache", "opencode", "packages", "@fro.bot", "systematic@1.0.0", "bin"),
      "helper.js",
      "cache helper\n",
    );
    const configured = writeHelper(join(base, "private"), "helper.js", "pinned helper\n");
    const verified = assertPinnedReviewHelper({
      reviewHelperPath: configured.path,
      reviewHelperSha256: configured.sha,
    });
    expect(verified.path).toBe(configured.path);
    expect(verified.path).not.toBe(cache.path);
    expect(verified.sha256).toBe(configured.sha);
    expect(verified.sha256).not.toBe(cache.sha);
  });

  test("an unconfigured pin never falls back to a package-cache helper", () => {
    const base = tempBase("helper-cache-unconfigured");
    writeHelper(
      join(base, "cache", "opencode", "packages", "@fro.bot", "systematic@1.0.0", "bin"),
      "helper.js",
      "cache helper\n",
    );
    const err = catchError(() =>
      assertPinnedReviewHelper({ reviewHelperPath: null, reviewHelperSha256: null }),
    );
    expect(err).toBeInstanceOf(ReviewHelperUnconfiguredError);
  });
});

describe("owner-session access", () => {
  test("the owning session is accepted", () => {
    const store = makeStore();
    const writer = store.createRun("sess-owner");
    expect(() => assertRunOwnership(writer.record, "sess-owner")).not.toThrow();
  });

  test("a foreign session is refused without echoing its id", () => {
    const store = makeStore();
    const writer = store.createRun("sess-owner");
    const foreign = "sess-intruder-9000";
    const err = catchError(() => assertRunOwnership(writer.record, foreign));
    expect(err).toBeInstanceOf(ReviewRunOwnershipError);
    expect(err.message).not.toContain(foreign);
    expect(err.message).toContain(writer.record.runId);
  });
});

describe("retention, expiry and recovery", () => {
  const DAY = 24 * 60 * 60 * 1000;

  function ageRun(runDir: string, ageMs: number, now: number): void {
    const when = new Date(now - ageMs);
    utimesSync(runDir, when, when);
  }

  function makePublishedRun(session: string): {
    store: ReviewRunStore;
    writer: ReturnType<ReviewRunStore["createRun"]>;
  } {
    const store = makeStore();
    const writer = store.createRun(session);
    writer.addArtifact("payload.txt", Buffer.from("x"));
    writer.publish();
    return { store, writer };
  }

  test("an expired published run is pruned and named in the summary", () => {
    const { store, writer } = makePublishedRun("sess-expired");
    const now = Date.now();
    ageRun(writer.runDir, 8 * DAY, now);
    const summary = pruneReviewRuns({ root: store.root, ttlMs: 7 * DAY, maxRuns: 64, now });
    expect(lstatExists(writer.runDir)).toBe(false);
    expect(summary.pruned.map((p) => p.runId)).toContain(writer.record.runId);
    expect(summary.pruned[0]!.reason).toBe("expired");
  });

  test("a run inside the TTL is untouched", () => {
    const { store, writer } = makePublishedRun("sess-fresh");
    const now = Date.now();
    ageRun(writer.runDir, DAY, now);
    const summary = pruneReviewRuns({ root: store.root, ttlMs: 7 * DAY, maxRuns: 64, now });
    expect(lstatExists(writer.runDir)).toBe(true);
    expect(summary.pruned).toEqual([]);
  });

  test("an expired publishing run is never pruned and never deleted", () => {
    const store = makeStore();
    const writer = store.createRun("sess-open");
    const now = Date.now();
    ageRun(writer.runDir, 8 * DAY, now);
    const summary = pruneReviewRuns({ root: store.root, ttlMs: 7 * DAY, maxRuns: 64, now });
    expect(lstatExists(writer.runDir)).toBe(true);
    expect(summary.pruned).toEqual([]);
    expect(summary.keptOpen.map((k) => k.runId)).toContain(writer.record.runId);
  });

  test("recovery marks an expired publishing run failed and records the interruption", () => {
    const store = makeStore();
    const writer = store.createRun("sess-interrupted");
    writer.addArtifact("partial.txt", Buffer.from("half"));
    const now = Date.now();
    ageRun(writer.runDir, 8 * DAY, now);
    const summary = recoverInterruptedRuns({ root: store.root, ttlMs: 7 * DAY, now });
    expect(summary.recovered.map((r) => r.runId)).toContain(writer.record.runId);
    expect(lstatExists(writer.runDir)).toBe(true);
    const meta = JSON.parse(readFileSync(join(writer.runDir, "metadata.json"), "utf8")) as {
      state: string;
      failureReason?: string;
    };
    expect(meta.state).toBe("failed");
    expect(meta.failureReason).toBe("interrupted");
  });

  test("recovery leaves a publishing run inside the TTL alone", () => {
    const store = makeStore();
    const writer = store.createRun("sess-interrupted-fresh");
    const now = Date.now();
    ageRun(writer.runDir, DAY, now);
    const summary = recoverInterruptedRuns({ root: store.root, ttlMs: 7 * DAY, now });
    expect(summary.recovered).toEqual([]);
    const meta = JSON.parse(readFileSync(join(writer.runDir, "metadata.json"), "utf8")) as {
      state: string;
    };
    expect(meta.state).toBe("publishing");
  });

  test("the global bound prunes oldest-first and never a publishing run", () => {
    const store = makeStore();
    const now = Date.now();
    const publishing = store.createRun("sess-bound-open");
    ageRun(publishing.runDir, 3 * DAY, now);
    const publishedOld = store.createRun("sess-bound-a");
    publishedOld.publish();
    ageRun(publishedOld.runDir, 2 * DAY, now);
    const publishedNew = store.createRun("sess-bound-b");
    publishedNew.publish();
    ageRun(publishedNew.runDir, DAY, now);

    const summary = pruneReviewRuns({ root: store.root, ttlMs: 30 * DAY, maxRuns: 2, now });
    // The oldest (publishing) is protected; the next-oldest published is pruned.
    expect(lstatExists(publishing.runDir)).toBe(true);
    expect(lstatExists(publishedOld.runDir)).toBe(false);
    expect(lstatExists(publishedNew.runDir)).toBe(true);
    expect(summary.pruned.map((p) => p.runId)).toEqual([publishedOld.record.runId]);
    expect(summary.pruned.every((p) => p.reason === "over-bound")).toBe(true);
  });

  test.each(["missing", "unparseable"] as const)("prune reports a %s metadata run as expired with null state", (kind) => {
    const { store, writer } = makePublishedRun(`sess-corrupt-${kind}`);
    const now = Date.now();
    const metadata = join(writer.runDir, "metadata.json");
    if (kind === "missing") rmSync(metadata);
    else writeFileSync(metadata, "{");
    ageRun(writer.runDir, 8 * DAY, now);
    const summary = pruneReviewRuns({ root: store.root, ttlMs: 7 * DAY, maxRuns: 64, now });
    expect(summary.pruned).toContainEqual({
      sessionID: writer.record.sessionID,
      runId: writer.record.runId,
      reason: "expired",
      state: null,
    });
    expect(lstatExists(writer.runDir)).toBe(false);
  });

  test.each(["missing", "unparseable"] as const)("prune removes a %s metadata run only when globally over bound", (kind) => {
    const store = makeStore();
    const writer = store.createRun(`sess-bound-corrupt-${kind}`);
    writer.publish();
    const metadata = join(writer.runDir, "metadata.json");
    if (kind === "missing") rmSync(metadata);
    else writeFileSync(metadata, "{");
    const now = Date.now();
    ageRun(writer.runDir, DAY, now);
    const summary = pruneReviewRuns({ root: store.root, ttlMs: 7 * DAY, maxRuns: 0, now });
    expect(summary.pruned).toContainEqual({
      sessionID: writer.record.sessionID,
      runId: writer.record.runId,
      reason: "over-bound",
      state: null,
    });
    expect(lstatExists(writer.runDir)).toBe(false);
  });

  test.each(["missing", "unparseable"] as const)("recovery skips a %s metadata run and leaves it intact", (kind) => {
    const store = makeStore();
    const writer = store.createRun(`sess-recovery-corrupt-${kind}`);
    const metadata = join(writer.runDir, "metadata.json");
    if (kind === "missing") rmSync(metadata);
    else writeFileSync(metadata, "{");
    const now = Date.now();
    ageRun(writer.runDir, 8 * DAY, now);
    const summary = recoverInterruptedRuns({ root: store.root, ttlMs: 7 * DAY, now });
    expect(summary.recovered).not.toContainEqual({ sessionID: writer.record.sessionID, runId: writer.record.runId });
    expect(summary.recovered).toEqual([]);
    expect(lstatExists(writer.runDir)).toBe(true);
    expect(lstatExists(metadata)).toBe(kind === "unparseable");
  });

  test("the per-session quota behaviour is unchanged after a prune", () => {
    const store = makeStore({ caps: { maxPerSession: 1 } });
    const writer = store.createRun("sess-quota-retained");
    writer.publish();
    const now = Date.now();
    const summary = pruneReviewRuns({ root: store.root, ttlMs: 30 * DAY, maxRuns: 64, now });
    expect(summary.pruned).toEqual([]);
    const err = catchError(() => store.createRun("sess-quota-retained"));
    expect(err).toBeInstanceOf(ReviewRunQuotaError);
  });
});

describe("race-resistant read helper", () => {
  function writeArtifact(runDir: string, name: string, data: Buffer | string): void {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, name), data);
  }

  test("a normal artifact reads byte-identical, including non-ASCII", () => {
    const runDir = tempBase("read-ok");
    const content = "héllo wörld — €5\n日本語\n";
    const input = Buffer.from(content, "utf8");
    writeArtifact(runDir, "note.txt", input);
    const read = readRunArtifact({ runDir, name: "note.txt", maxFileBytes: 1024 });
    expect(read.data.equals(input)).toBe(true);
    expect(read.bytes).toBe(input.byteLength);
    expect(read.sha256).toBe(sha256Hex(input));
    // More UTF-8 bytes than UTF-16 units: a String.length cap would drift.
    expect(read.bytes).toBeGreaterThan(content.length);
  });

  test("a path traversal attempt is refused", () => {
    const base = tempBase("read-traversal");
    const runDir = join(base, "run");
    writeArtifact(runDir, "inside.txt", "inside");
    writeFileSync(join(base, "secret.txt"), "secret");
    for (const name of ["../secret.txt", "../../etc/passwd", "sub/../../secret.txt"]) {
      const err = catchError(() => readRunArtifact({ runDir, name, maxFileBytes: 1024 }));
      expect(err).toBeInstanceOf(ReviewRunError);
    }
  });

  test("a symlink whose target lies outside the run dir is refused as an escape", () => {
    const base = tempBase("read-escape");
    const runDir = join(base, "run");
    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret");
    writeArtifact(runDir, "real.txt", "real");
    symlinkSync(join(outside, "secret.txt"), join(runDir, "escape.txt"));
    const err = catchError(() => readRunArtifact({ runDir, name: "escape.txt", maxFileBytes: 1024 }));
    expect(err).toBeInstanceOf(ReviewRunArtifactEscapeError);
  });

  test("a symlink whose target lies inside the run dir is still refused (never followed)", () => {
    const runDir = tempBase("read-link-inside");
    writeArtifact(runDir, "real.txt", "real");
    symlinkSync(join(runDir, "real.txt"), join(runDir, "alias.txt"));
    const err = catchError(() => readRunArtifact({ runDir, name: "alias.txt", maxFileBytes: 1024 }));
    expect(err).toBeInstanceOf(ReviewRunArtifactSymlinkError);
  });

  test("missing no-follow capability refuses before open", () => {
    const runDir = tempBase("read-no-follow-absent");
    writeArtifact(runDir, "note.txt", "payload");
    let opens = 0;
    const err = catchError(() => readRunArtifact({
      runDir,
      name: "note.txt",
      maxFileBytes: 1024,
      noFollowFlag: null,
      open: ((...args: Parameters<typeof openSync>) => { opens += 1; return openSync(...args); }) as typeof openSync,
    }));
    expect(opens).toBe(0);
    expect(err).toBeInstanceOf(ReviewRunError);
    expect((err as ReviewRunError & { code: string }).code).toBe("review_run_artifact_no_follow_unavailable");
    expect(err.message).toContain("no-follow");
  });

  test("an unusable no-follow flag is a named refusal", () => {
    const runDir = tempBase("read-no-follow-unusable");
    writeArtifact(runDir, "note.txt", "payload");
    const err = catchError(() => readRunArtifact({
      runDir,
      name: "note.txt",
      maxFileBytes: 1024,
      open: (() => { throw Object.assign(new Error("unsupported flag"), { code: "EINVAL" }); }) as typeof openSync,
    }));
    expect((err as ReviewRunError & { code: string }).code).toBe("review_run_artifact_no_follow_unavailable");
    expect(err.message).toContain("no-follow capability is unusable");
  });

  test("a directory in place of a file is refused as not a regular file", () => {
    const runDir = tempBase("read-dir");
    mkdirSync(join(runDir, "adir"), { recursive: true });
    const err = catchError(() => readRunArtifact({ runDir, name: "adir", maxFileBytes: 1024 }));
    expect(err).toBeInstanceOf(ReviewRunArtifactNotRegularError);
  });

  test("an over-cap file is refused naming the cap and the observed size", () => {
    const runDir = tempBase("read-cap");
    writeArtifact(runDir, "big.bin", Buffer.alloc(10, 0x61));
    const err = catchError(() => readRunArtifact({ runDir, name: "big.bin", maxFileBytes: 4 }));
    expect(err).toBeInstanceOf(ReviewRunArtifactCapError);
    expect(err.message).toContain("10");
    expect(err.message).toContain("4");
  });

  test("a file exactly at the cap is accepted", () => {
    const runDir = tempBase("read-exact");
    writeArtifact(runDir, "exact.bin", Buffer.alloc(4, 0x61));
    const read = readRunArtifact({ runDir, name: "exact.bin", maxFileBytes: 4 });
    expect(read.bytes).toBe(4);
  });

  test("the run record is not readable through the artifact path without explicit opt-in", () => {
    const runDir = tempBase("read-record");
    writeArtifact(runDir, "metadata.json", "{\"state\":\"published\"}");
    const err = catchError(() =>
      readRunArtifact({ runDir, name: "metadata.json", maxFileBytes: 1024 }),
    );
    expect(err).toBeInstanceOf(ReviewRunError);
    expect((err as ReviewRunError).code).toBe("review_run_artifact_name_reserved");
  });

  test("the run record is readable only with allowRecord", () => {
    const runDir = tempBase("read-record-ok");
    const body = "{\"state\":\"published\"}\n";
    writeArtifact(runDir, "metadata.json", body);
    const read = readRunArtifact({
      runDir,
      name: "metadata.json",
      maxFileBytes: 1024,
      allowRecord: true,
    });
    expect(read.data.toString("utf8")).toBe(body);
  });

  test("a missing artifact is refused", () => {
    const runDir = tempBase("read-missing");
    const err = catchError(() => readRunArtifact({ runDir, name: "nope.bin", maxFileBytes: 1024 }));
    expect(err).toBeInstanceOf(ReviewRunArtifactNotFoundError);
  });
});
