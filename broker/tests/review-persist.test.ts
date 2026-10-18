import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExec } from "../src/msb.ts";
import { persistReviewArtifact } from "../src/review-persist.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-persist-"));
  roots.push(root);
  Bun.spawnSync(["git", "init", "--quiet", root]);
  const context = join(root, ".context");
  const reviewRoot = join(context, "systematic", "ce-review");
  const runId = "a".repeat(32);
  const runDir = join(reviewRoot, runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const storeRoot = mkdtempSync(join(tmpdir(), "review-store-"));
  roots.push(storeRoot);
  const storeRunDir = join(storeRoot, runId);
  mkdirSync(storeRunDir, { recursive: true, mode: 0o700 });
  const helper = join(root, "validate-review.mjs");
  writeFileSync(helper, `#!${process.execPath}\nconst status = process.env.FIXTURE_STATUS;\nif (status === 'invalid') { process.stderr.write('issue: missing required field\\n'); process.exit(1); }\nprocess.exit(status === 'ok' ? 0 : status === 'legacy' ? 3 : 2);\n`);
  chmodSync(helper, 0o700);
  const helperSha256 = createHash("sha256").update(readFileSync(helper)).digest("hex");
  return { root, context, runDir, runId, storeRunDir, reviewHelperPath: helper, reviewHelperSha256: helperSha256, reviewHelperInterpreter: process.execPath };
}

const writing = (artifact: unknown) => ({ outcome: "accepted" as const, output: { kind: "writing", artifact, report: { private: "report-only" } } });

test("persists only artifact and adds schema_version after making the directory effectively ignored", async () => {
  const f = fixture();
  const calls: Array<{ argv: string[]; options: { cwd?: string } }> = [];
  const spawn = async (argv: string[], options: Parameters<typeof spawnExec>[1]) => { calls.push({ argv, options }); return spawnExec(argv, options); };
  const result = await persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }), env: { FIXTURE_STATUS: "ok" }, spawn });
  const stageRoot = join(f.storeRunDir, "staging");
  const stagedRelativePath = `.context/systematic/ce-review/${f.runId}/review-summary.json`;
  expect(calls.some((call) => call.argv[0] === process.execPath && call.argv[1] === f.reviewHelperPath && call.options.cwd === stageRoot && call.argv[2] === "artifact" && call.argv[3] === stagedRelativePath && call.argv.length === 4)).toBe(true);
  if (result.validation.status !== "passed") throw new Error(JSON.stringify(result.validation));
  const target = join(f.runDir, "review-summary.json");
  const parsed = JSON.parse(readFileSync(target, "utf8"));
  expect(parsed.schema_version).toBe(1);
  expect(parsed).toEqual({ findings: [], schema_version: 1 });
  expect(readFileSync(target, "utf8")).not.toContain("report");
  expect(readFileSync(join(f.context, ".gitignore"), "utf8")).toContain(`systematic/ce-review/${f.runId}/`);
  expect(Bun.spawnSync(["git", "check-ignore", "-q", "--", target], { cwd: f.root }).exitCode).toBe(0);
  const siblingRun = join(f.context, "systematic", "ce-review", "b".repeat(32), "review-summary.json");
  expect(Bun.spawnSync(["git", "check-ignore", "-q", "--", siblingRun], { cwd: f.root }).exitCode).toBe(1);
});

test("refuses an existing ignore file over the bounded read cap with cap and observed size", async () => {
  const f = fixture();
  const oversized = Buffer.alloc(64 * 1024 + 1, 0x61);
  writeFileSync(join(f.context, ".gitignore"), oversized);
  await expect(persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }) }))
    .rejects.toThrow(`65536-byte cap (observed 65537 bytes)`);
});

test("reports an ignore-file creation when artifact validation is incomplete", async () => {
  const f = fixture();
  const result = await persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }), env: { FIXTURE_STATUS: "invalid" } });
  expect(result.outcome).toBe("incomplete");
  expect(result.validation.status).toBe("failed");
  expect(result.ignoreFile).toEqual({ status: "created" });
  expect(readFileSync(join(f.context, ".gitignore"), "utf8")).toContain(`systematic/ce-review/${f.runId}/`);
});

test("project .gitconfig does not become global config for ignore checks", async () => {
  const f = fixture();
  const excludes = join(f.root, "project-excludes");
  writeFileSync(excludes, `/.context/systematic/ce-review/${f.runId}/\n`);
  writeFileSync(join(f.root, ".gitconfig"), `[core]\n\texcludesFile = ${excludes}\n`);
  const result = await persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }), env: { FIXTURE_STATUS: "ok" } });
  expect(result.ignoreFile.status).toBe("created");
  expect(existsSync(join(f.context, ".gitignore"))).toBe(true);
});

test("ignore checks use fixed argv and replacement environment before and after provisioning", async () => {
  const f = fixture();
  const calls: Array<{ argv: string[]; options: { cwd?: string; envMode?: string; env?: Record<string, string> } }> = [];
  const spawn = async (argv: string[], options: Parameters<typeof spawnExec>[1]) => {
    calls.push({ argv, options });
    return spawnExec(argv, options);
  };
  await persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }), env: { FIXTURE_STATUS: "ok" }, spawn });
  const ignoreCalls = calls.filter((call) => call.argv[0] === "git");
  expect(ignoreCalls).toHaveLength(2);
  expect(ignoreCalls[0]?.argv).toEqual(["git", "check-ignore", "-q", "--", join(f.runDir, "review-summary.json")]);
  expect(ignoreCalls[1]?.argv).toEqual(ignoreCalls[0]?.argv);
  for (const call of ignoreCalls) {
    expect(call.options.cwd).toBe(f.root);
    expect(call.options.envMode).toBe("replace");
    expect(call.options.env).toEqual({ PATH: process.env.PATH ?? "", HOME: homedir(), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
    expect(call.options.env?.HOME).not.toBe(f.root);
  }
});

test("fails closed when the post-write ignore verification is ineffective", async () => {
  const f = fixture();
  let checks = 0;
  const spawn = async (argv: string[], options: Parameters<typeof spawnExec>[1]) => {
    const result = await spawnExec(argv, options);
    if (argv[0] === "git" && ++checks === 2) return { ...result, status: 1 };
    return result;
  };
  await expect(persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }), spawn })).rejects.toMatchObject({ code: "review_ignore_ineffective" });
  expect(existsSync(join(f.runDir, "review-summary.json"))).toBe(false);
});

test("already ignored context performs no ignore-file write", async () => {
  const f = fixture();
  writeFileSync(join(f.root, ".gitignore"), ".context/\n");
  const before = statSync(f.context).mtimeMs;
  await persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }), env: { FIXTURE_STATUS: "ok" } });
  expect(existsSync(join(f.context, ".gitignore"))).toBe(false);
  expect(statSync(f.context).mtimeMs).toBe(before);
});

test("second persist does not duplicate the ignore entry", async () => {
  const f = fixture();
  for (let index = 0; index < 2; index++) await persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }), env: { FIXTURE_STATUS: "ok" } });
  const ignore = readFileSync(join(f.context, ".gitignore"), "utf8");
  expect(ignore.split("systematic/ce-review/").length - 1).toBe(1);
});

test("append preserves the existing ignore bytes", async () => {
  const f = fixture();
  const prior = Buffer.from("# local context rules\r\n*.private\n", "utf8");
  writeFileSync(join(f.context, ".gitignore"), prior);
  await persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }), env: { FIXTURE_STATUS: "ok" } });
  const current = readFileSync(join(f.context, ".gitignore"));
  expect(current.subarray(0, prior.byteLength)).toEqual(prior);
});

test("refuses to duplicate an existing ineffective or negated entry", async () => {
  const f = fixture();
  writeFileSync(join(f.context, ".gitignore"), `systematic/ce-review/${f.runId}/\n!systematic/ce-review/${f.runId}/\n`);
  await expect(persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }) })).rejects.toMatchObject({ code: "review_ignore_ineffective" });
});

test("forces the artifact mode to 0600 despite a restrictive umask", async () => {
  const f = fixture();
  writeFileSync(join(f.root, ".gitignore"), ".context/\n");
  const previousUmask = process.umask();
  let restrictive = false;
  try {
    await persistReviewArtifact({
      ...f, mode: "write", finalize: writing({ findings: [] }), env: { FIXTURE_STATUS: "ok" },
      beforeTempCreate: () => { process.umask(0o777); restrictive = true; },
      beforeRename: () => { process.umask(previousUmask); restrictive = false; },
    });
  } finally {
    if (restrictive) process.umask(previousUmask);
  }
  expect(statSync(join(f.runDir, "review-summary.json")).mode & 0o777).toBe(0o600);
});

test("refuses when directory-handle paths are unavailable without writing", async () => {
  const f = fixture();
  const contextBefore = readdirSync(f.context).sort();
  let spawned = false;
  const spawn = async (argv: string[], options: Parameters<typeof spawnExec>[1]) => {
    spawned = true;
    return spawnExec(argv, options);
  };
  await expect(persistReviewArtifact({
    ...f, mode: "write", finalize: writing({ findings: [] }), spawn,
    procFdAvailable: () => false,
  })).rejects.toMatchObject({ code: "review_persist_fd_path_unavailable" });
  expect(spawned).toBe(false);
  expect(readdirSync(f.context).sort()).toEqual(contextBefore);
  expect(existsSync(join(f.runDir, "review-summary.json"))).toBe(false);
  expect(readdirSync(f.runDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("creates missing containment directories at mode 0700 and the artifact at mode 0600", async () => {
  const f = fixture();
  rmSync(f.context, { recursive: true });
  const result = await persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }), env: { FIXTURE_STATUS: "ok" } });
  expect(result.outcome).toBe("persisted");
  for (const directory of [f.context, join(f.context, "systematic"), join(f.context, "systematic", "ce-review"), f.runDir]) {
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  }
  expect(statSync(join(f.runDir, "review-summary.json")).mode & 0o777).toBe(0o600);
});

test("refuses a symlinked ancestor directory", async () => {
  const f = fixture();
  const systematic = join(f.context, "systematic");
  const external = join(f.root, "external-systematic");
  rmSync(systematic, { recursive: true });
  mkdirSync(external);
  symlinkSync(external, systematic);
  await expect(persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }) })).rejects.toMatchObject({ code: "review_persist_unsafe_directory" });
});

test("keeps ignore provisioning on the verified context inode during an ancestor swap", async () => {
  const f = fixture();
  const movedContext = `${f.context}-moved`;
  const externalContext = join(f.root, "external-context");
  mkdirSync(externalContext, { mode: 0o711 });
  const marker = join(externalContext, "marker.bin");
  writeFileSync(marker, Buffer.from([9, 0, 255]));
  chmodSync(marker, 0o640);
  const beforeEntries = readdirSync(externalContext).sort();
  const beforeMode = statSync(externalContext).mode & 0o777;
  const beforeBytes = readFileSync(marker);
  const beforeFileMode = statSync(marker).mode & 0o777;
  let swapped = false;
  const spawn = async (argv: string[], options: Parameters<typeof spawnExec>[1]) => {
    const result = await spawnExec(argv, options);
    if (argv[0] === "git" && result.status === 1 && !swapped) {
      renameSync(f.context, movedContext);
      symlinkSync(externalContext, f.context);
      swapped = true;
    }
    return result;
  };

  await expect(persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }), spawn })).rejects.toMatchObject({ code: "review_ignore_ineffective" });
  expect(swapped).toBe(true);
  expect(readdirSync(externalContext).sort()).toEqual(beforeEntries);
  expect(statSync(externalContext).mode & 0o777).toBe(beforeMode);
  expect(readFileSync(marker)).toEqual(beforeBytes);
  expect(statSync(marker).mode & 0o777).toBe(beforeFileMode);
  expect(existsSync(join(externalContext, ".gitignore"))).toBe(false);
  expect(readFileSync(join(movedContext, ".gitignore"), "utf8")).toContain(`systematic/ce-review/${f.runId}/`);
});

test("rechecks the anchored run directory after git awaits before writing", async () => {
  const f = fixture();
  const outside = join(tmpdir(), `review-persist-outside-${f.runId}`);
  roots.push(outside);
  const outsideContext = `${outside}-context`;
  roots.push(outsideContext);
  mkdirSync(outside, { mode: 0o711 });
  const marker = join(outside, "marker.bin");
  writeFileSync(marker, Buffer.from([3, 0, 255]));
  chmodSync(marker, 0o640);
  const before = { entries: readdirSync(outside).sort(), bytes: readFileSync(marker), dirMode: statSync(outside).mode & 0o777, fileMode: statSync(marker).mode & 0o777 };
  writeFileSync(join(f.root, ".gitignore"), ".context/\n");
  let moved = false;
  const spawn = async (argv: string[], options: Parameters<typeof spawnExec>[1]) => {
    const result = await spawnExec(argv, options);
    if (argv[0] === "git" && !moved) { renameSync(f.context, outsideContext); moved = true; }
    return result;
  };
  await expect(persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }), env: { FIXTURE_STATUS: "ok" }, spawn }))
    .rejects.toMatchObject({ code: "review_persist_anchor_changed" });
  expect(moved).toBe(true);
  expect(existsSync(join(outsideContext, "systematic", "ce-review", f.runId, "review-summary.json"))).toBe(false);
  expect(readdirSync(outside).sort()).toEqual(before.entries);
  expect(readFileSync(marker)).toEqual(before.bytes);
  expect(statSync(outside).mode & 0o777).toBe(before.dirMode);
  expect(statSync(marker).mode & 0o777).toBe(before.fileMode);
});

test("refuses a symlinked context ignore file", async () => {
  const f = fixture();
  const external = join(f.root, "external-ignore");
  writeFileSync(external, "");
  symlinkSync(external, join(f.context, ".gitignore"));
  await expect(persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }) })).rejects.toMatchObject({ code: "review_ignore_symlink" });
});

test("does not write into an external directory after a verified run directory is replaced by a symlink", async () => {
  const f = fixture();
  const external = join(f.root, "external-target");
  const moved = `${f.runDir}-moved`;
  mkdirSync(external, { mode: 0o711 });
  const sentinel = join(external, "sentinel.bin");
  writeFileSync(sentinel, Buffer.from([0, 255, 17]));
  chmodSync(sentinel, 0o640);
  const before = {
    entries: readdirSync(external).sort(),
    directoryMode: statSync(external).mode & 0o777,
    sentinelBytes: readFileSync(sentinel),
    sentinelMode: statSync(sentinel).mode & 0o777,
  };
  let swapped = false;
  await expect(persistReviewArtifact({
    ...f, mode: "write", finalize: writing({ findings: [] }), env: { FIXTURE_STATUS: "ok" },
    beforeTempCreate: () => {
      renameSync(f.runDir, moved);
      symlinkSync(external, f.runDir);
      swapped = true;
    },
  })).rejects.toMatchObject({ code: "review_persist_anchor_changed" });
  expect(swapped).toBe(true);
  expect(readdirSync(external).sort()).toEqual(before.entries);
  expect(statSync(external).mode & 0o777).toBe(before.directoryMode);
  expect(readFileSync(sentinel)).toEqual(before.sentinelBytes);
  expect(statSync(sentinel).mode & 0o777).toBe(before.sentinelMode);
  expect(existsSync(join(external, "review-summary.json"))).toBe(false);
  expect(readdirSync(moved).some((name) => name.startsWith(".review-summary."))).toBe(false);
  expect(existsSync(join(moved, "review-summary.json"))).toBe(false);
});

test("removes the exclusively created temp file when rename preparation fails", async () => {
  const f = fixture();
  await expect(persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }), env: { FIXTURE_STATUS: "ok" }, beforeRename: () => { throw new Error("simulated rename failure"); } })).rejects.toThrow("simulated rename failure");
  expect(readdirSync(f.runDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("reports ignore-file mutation when artifact publication fails", async () => {
  const f = fixture();
  await expect(persistReviewArtifact({
    ...f, mode: "write", finalize: writing({ findings: [] }), env: { FIXTURE_STATUS: "ok" },
    beforeTempCreate: () => { throw new Error("simulated artifact publication failure"); },
  })).rejects.toThrow(".context/.gitignore was created");
  const ignorePath = join(f.context, ".gitignore");
  expect(existsSync(ignorePath)).toBe(true);
  expect(readFileSync(ignorePath, "utf8")).toContain(`systematic/ce-review/${f.runId}/`);
  expect(existsSync(join(f.runDir, "review-summary.json"))).toBe(false);
});

test("preserves partial ignore mutation when post-write verification fails", async () => {
  const f = fixture();
  let checks = 0;
  const spawn = async (argv: string[], options: Parameters<typeof spawnExec>[1]) => {
    const result = await spawnExec(argv, options);
    if (argv[0] === "git" && ++checks === 2) return { ...result, status: 1 };
    return result;
  };
  const error = await persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }), spawn })
    .then(() => { throw new Error("persist unexpectedly resolved"); }, (cause: unknown) => cause);
  expect(error).toMatchObject({ code: "review_ignore_ineffective" });
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(".context/.gitignore was created and remains modified");
  expect(readFileSync(join(f.context, ".gitignore"), "utf8")).toContain(`systematic/ce-review/${f.runId}/`);
  expect(existsSync(join(f.runDir, "review-summary.json"))).toBe(false);
});

test("report-only mode writes no artifact and does not invoke validation", async () => {
  const f = fixture();
  const result = await persistReviewArtifact({ ...f, mode: "report_only", finalize: writing({ findings: [] }) });
  expect(result).toEqual({ outcome: "report_only", validation: { status: "not_attempted", code: "review_artifact_not_attempted" }, ignoreFile: { status: "unchanged" } });
  expect(existsSync(join(f.runDir, "review-summary.json"))).toBe(false);
});

test("failed artifact validation publishes nothing to the project and retains staged evidence", async () => {
  const f = fixture();
  const result = await persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }), env: { FIXTURE_STATUS: "invalid" } });
  expect(result.outcome).toBe("incomplete");
  expect(result.validation).toMatchObject({ status: "failed", code: "review_artifact_validation_failed", reason: expect.stringContaining("issue: missing required field") });
  expect(existsSync(join(f.runDir, "review-summary.json"))).toBe(false);
  expect(readdirSync(f.runDir).filter((name) => name.startsWith(".review-summary.") && name.endsWith(".tmp"))).toEqual([]);
  expect(result.path).toBeUndefined();
  expect(result.stagingPath).toBe(`staging/.context/systematic/ce-review/${f.runId}/review-summary.json`);
  expect(existsSync(join(f.storeRunDir, result.stagingPath!))).toBe(true);
});

test("refuses a staging run directory inside the project", async () => {
  const f = fixture();
  await expect(persistReviewArtifact({ ...f, storeRunDir: f.runDir, mode: "write", finalize: writing({ findings: [] }) }))
    .rejects.toMatchObject({ code: "review_persist_staging_path" });
  expect(existsSync(join(f.runDir, "review-summary.json"))).toBe(false);
});

test("legacy artifact exit is unavailable with a distinct legacy reason", async () => {
  const f = fixture();
  const result = await persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }), env: { FIXTURE_STATUS: "legacy" } });
  expect(result.validation).toMatchObject({ status: "unavailable", code: "review_artifact_validator_unavailable" });
  expect(result.validation.status === "unavailable" ? result.validation.reason : "").toContain("legacy artifact");
});

test("missing validator is unavailable with a distinct reason", async () => {
  const f = fixture();
  const result = await persistReviewArtifact({ ...f, reviewHelperPath: join(f.root, "missing-helper"), mode: "write", finalize: writing({ findings: [] }) });
  expect(result.outcome).toBe("incomplete");
  expect(result.validation.status).toBe("unavailable");
  expect(result.validation.code).toBe("review_artifact_validator_unavailable");
  expect(result.validation.reason).toContain("does not exist");
  expect(existsSync(join(f.runDir, "review-summary.json"))).toBe(false);
  expect(result.stagingPath).toBe(`staging/.context/systematic/ce-review/${f.runId}/review-summary.json`);
  expect(existsSync(join(f.storeRunDir, result.stagingPath!))).toBe(true);
});

test("unstartable validator is unavailable with a reason distinct from absence", async () => {
  const f = fixture();
  chmodSync(f.reviewHelperPath, 0o600);
  const result = await persistReviewArtifact({ ...f, mode: "write", finalize: writing({ findings: [] }) });
  expect(result.validation.status).toBe("unavailable");
  expect(result.validation.code).toBe("review_artifact_validator_unavailable");
  expect(result.validation.reason).toContain("status 2");
});

test("refuses structurally rejected and unavailable finalize outcomes", async () => {
  const f = fixture();
  await expect(persistReviewArtifact({ ...f, mode: "write", finalize: { outcome: "structurally_rejected", code: "review_pipeline_structurally_rejected", diagnostic: "invalid" } })).rejects.toMatchObject({ code: "review_persist_rejected" });
  await expect(persistReviewArtifact({ ...f, mode: "write", finalize: { outcome: "validation_unavailable", code: "review_pipeline_validation_unavailable", diagnostic: "missing" } })).rejects.toMatchObject({ code: "review_persist_unavailable" });
});

test("refuses a non-writing finalize wrapper", async () => {
  const f = fixture();
  await expect(persistReviewArtifact({ ...f, mode: "write", finalize: { outcome: "accepted", output: { kind: "report", report: {} } } })).rejects.toMatchObject({ code: "review_persist_kind" });
});
