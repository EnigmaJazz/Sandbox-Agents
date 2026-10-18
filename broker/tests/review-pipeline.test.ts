import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runReviewPipeline, REVIEW_PIPELINE_MAX_STDIN_BYTES } from "../src/review-pipeline.ts";
import { spawnExec, type SpawnFn } from "../src/msb.ts";
import { assertPayloadKeys, ValidationError } from "../src/validation.ts";
import { ReviewRunStore } from "../src/review-run.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-pipeline-"));
  roots.push(root);
  const helper = join(root, "validate-review.mjs");
  writeFileSync(helper, `#!/usr/bin/env node
import { createHash } from 'node:crypto';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks);
const mode = process.env.FIXTURE_MODE || 'accept';
if (mode === 'reject') { process.stderr.write('invalid envelope'); process.exit(1); }
if (mode === 'internal-error') { process.stderr.write('ce-review-validator: internal error in finalize'); process.exit(1); }
if (mode === 'unavailable') process.exit(2);
if (mode === 'oversize') { const prefix = '{"oversized":"'; const total = Number(process.env.OVERSIZE_BYTES); process.stdout.write(prefix + 'x'.repeat(total - prefix.length - 2) + '"}', () => {}); }
else process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input: input.toString('utf8'), stdinSha256: createHash('sha256').update(input).digest('hex') }));
`);
  chmodSync(helper, 0o700);
  const digest = createHash("sha256").update(readFileSync(helper)).digest("hex");
  const project = join(root, "project");
  mkdirSync(project);
  const storeRoot = mkdtempSync(join("/var/tmp", "review-pipeline-fixture-store-"));
  roots.push(storeRoot);
  const store = new ReviewRunStore({ root: storeRoot, projectRoot: project });
  return { helper, digest, store, project, sessionID: "phase-owner", config: { reviewHelperPath: helper, reviewHelperSha256: digest, reviewHelperInterpreter: process.execPath } };
}

test("publishes phase output by reference and refuses missing or conflicting stdin sources", async () => {
  const pin = fixture();
  const { mkdtempSync, mkdirSync, readdirSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "review-pipeline-store-"));
  roots.push(root);
  const sessionID = "phase-owner";
  const project = join(root, "project");
  mkdirSync(project);
  const storeRoot = mkdtempSync(join("/var/tmp", "review-pipeline-store-root-"));
  roots.push(storeRoot);
  const store = new (await import("../src/review-run.ts")).ReviewRunStore({ root: storeRoot, projectRoot: project });
  const writer = store.createRun(sessionID);
  const result = await runReviewPipeline(
    { runId: writer.record.runId, phase: "prepare", stdin: "{}" } as never,
    pin.config,
    undefined,
    { store, sessionID } as never,
  ) as { outcome: string; artifact: { name: string; bytes: number; sha256: string }; summary: unknown; output?: unknown };
  const artifactBytes = readFileSync(join(store.runDir(sessionID, writer.record.runId), "phase-prepare.json"));
  expect(result.outcome).toBe("accepted");
  expect(result.artifact).toEqual({ name: "phase-prepare.json", bytes: artifactBytes.byteLength, sha256: createHash("sha256").update(artifactBytes).digest("hex") });
  expect(result).not.toHaveProperty("output");
  await expect(runReviewPipeline(
    { runId: writer.record.runId, phase: "merge" } as never, pin.config, undefined, { store, sessionID } as never,
  )).rejects.toMatchObject({ code: "review_pipeline_stdin_source_missing" });
  await expect(runReviewPipeline(
    { runId: writer.record.runId, phase: "merge", stdin: "{}", inputRef: "phase-prepare.json" } as never,
    pin.config, undefined, { store, sessionID } as never,
  )).rejects.toMatchObject({ code: "review_pipeline_stdin_source_conflict" });
  await expect(runReviewPipeline(
    { runId: writer.record.runId, phase: "merge", inputRef: "phase-finalize.json" } as never,
    pin.config, undefined, { store, sessionID } as never,
  )).rejects.toMatchObject({ code: "review_pipeline_input_ref_not_prior" });
  await expect(runReviewPipeline(
    { runId: writer.record.runId, phase: "merge", inputRef: "unrecognized.json" } as never,
    pin.config, undefined, { store, sessionID } as never,
  )).rejects.toMatchObject({ code: "review_pipeline_input_ref_unknown" });
  expect(readdirSync(store.runDir(sessionID, writer.record.runId)).sort()).toContain("phase-prepare.json");
});

test("accepts a chained phase artifact larger than the inline stdin cap", async () => {
  const pin = fixture();
  const writer = pin.store.createRun(pin.sessionID);
  const input = Buffer.from(JSON.stringify({ value: "x".repeat(REVIEW_PIPELINE_MAX_STDIN_BYTES) }));
  writer.addArtifact("phase-prepare.json", input);
  const result = await runReviewPipeline(
    { phase: "merge", runId: writer.record.runId, inputRef: "phase-prepare.json" },
    pin.config, undefined, { store: pin.store, sessionID: pin.sessionID },
  );
  expect(result.outcome).toBe("accepted");
  expect(pin.store.readRecord(pin.sessionID, writer.record.runId).artifacts.map(({ name }) => name)).toContain("phase-merge.json");
});

test("publishes a distinct run-accounted artifact for every screen reviewer", async () => {
  const pin = fixture();
  const writer = pin.store.createRun(pin.sessionID);
  for (const reviewer of ["review-risk", "review-resilience", "review-readability", "review-reliability"] as const) {
    await runReviewPipeline({ phase: "screen", reviewer, runId: writer.record.runId, stdin: "{}" }, pin.config, undefined, { store: pin.store, sessionID: pin.sessionID });
  }
  const record = pin.store.readRecord(pin.sessionID, writer.record.runId);
  expect(record.artifacts.map(({ name }) => name).sort()).toEqual([
    "phase-screen-review-readability.json", "phase-screen-review-reliability.json",
    "phase-screen-review-resilience.json", "phase-screen-review-risk.json",
  ]);
  expect(record.artifacts.reduce((total, artifact) => total + artifact.bytes, 0)).toBeGreaterThan(0);
});

test("enforces the per-run cap before publishing a phase artifact", async () => {
  const pin = fixture();
  const store = new ReviewRunStore({ root: pin.store.root, projectRoot: pin.project, caps: { ...pin.store.caps, maxBytes: 1 } });
  const writer = store.createRun(pin.sessionID);
  await expect(runReviewPipeline(
    { phase: "prepare", runId: writer.record.runId, stdin: "{}" }, pin.config, undefined, { store, sessionID: pin.sessionID },
  )).rejects.toMatchObject({ code: "review_run_byte_cap" });
  expect(readdirSync(store.runDir(pin.sessionID, writer.record.runId))).not.toContain("phase-prepare.json");
});

test("runs a mode-0600 pinned helper through its configured interpreter", async () => {
  const pin = fixture();
  chmodSync(pin.helper, 0o600);
  const config = { ...pin.config, reviewHelperInterpreter: process.execPath };
  const writer = pin.store.createRun(pin.sessionID);
  let observedArgv: string[] = [];
  const result = await runReviewPipeline(
    { phase: "prepare", runId: writer.record.runId, stdin: "{}" }, config,
    (argv, options) => { observedArgv = argv; return spawnExec(argv, options); },
    { store: pin.store, sessionID: pin.sessionID },
  );
  expect(observedArgv).toEqual([process.execPath, pin.helper, "prepare"]);
  expect(result).toMatchObject({ outcome: "accepted", artifact: { name: "phase-prepare.json" }, summary: { phase: "prepare" } });
  expect(JSON.parse(readFileSync(join(pin.store.runDir(pin.sessionID, writer.record.runId), "phase-prepare.json"), "utf8")))
    .toEqual({ argv: ["prepare"], input: "{}", stdinSha256: createHash("sha256").update("{}").digest("hex") });
});

test("refuses an unconfigured interpreter before spawning", async () => {
  const pin = fixture();
  let spawns = 0;
  const spawn: SpawnFn = async () => { spawns++; throw new Error("must not spawn"); };
  await expect(runReviewPipeline(
    { phase: "prepare", runId: "a".repeat(32), stdin: "{}" },
    { ...pin.config, reviewHelperInterpreter: null }, spawn,
  )).rejects.toThrow("review helper interpreter is not configured");
  expect(spawns).toBe(0);
});

test("refuses missing, symlinked, and non-executable interpreters by distinct code", async () => {
  const pin = fixture();
  const missing = join(pin.helper, "..", "missing-interpreter");
  const symlink = join(pin.helper, "..", "symlink-interpreter");
  symlinkSync(process.execPath, symlink);
  const nonExecutable = join(pin.helper, "..", "non-executable-interpreter");
  writeFileSync(nonExecutable, "not executable");
  chmodSync(nonExecutable, 0o600);
  for (const [interpreter, code] of [
    [missing, "review_helper_interpreter_missing"],
    [symlink, "review_helper_interpreter_not_regular"],
    [nonExecutable, "review_helper_interpreter_not_executable"],
  ] as const) {
    await expect(runReviewPipeline(
      { phase: "prepare", runId: "a".repeat(32), stdin: "{}" },
      { ...pin.config, reviewHelperInterpreter: interpreter },
    )).rejects.toMatchObject({ code });
  }
});

test("runs fixed phase argv with byte-identical stdin and no caller-controlled harness", async () => {
  const pin = fixture();
  const payload = "{\"value\":\"snowman ☃\"}";
  const writer = pin.store.createRun(pin.sessionID);
  const result = await runReviewPipeline({ phase: "screen", reviewer: "review-risk", runId: writer.record.runId, stdin: payload }, pin.config, undefined, { store: pin.store, sessionID: pin.sessionID });
  expect(result).toMatchObject({ outcome: "accepted", artifact: { name: "phase-screen-review-risk.json" } });
  expect(JSON.parse(readFileSync(join(pin.store.runDir(pin.sessionID, writer.record.runId), "phase-screen-review-risk.json"), "utf8"))).toEqual({ argv: ["screen", "--reviewer", "review-risk", "--harness", "opencode"], input: payload, stdinSha256: createHash("sha256").update(payload).digest("hex") });
});

test("refuses an over-cap stdin payload and names its observed byte size without spawning", async () => {
  const pin = fixture();
  let spawns = 0;
  const spawn: SpawnFn = async () => { spawns++; throw new Error("must not spawn"); };
  const input = "x".repeat(REVIEW_PIPELINE_MAX_STDIN_BYTES + 1);
  await expect(runReviewPipeline({ phase: "prepare", runId: "b".repeat(32), stdin: input }, pin.config, spawn))
    .rejects.toThrow(`${REVIEW_PIPELINE_MAX_STDIN_BYTES} bytes (observed ${REVIEW_PIPELINE_MAX_STDIN_BYTES + 1} bytes)`);
  expect(spawns).toBe(0);
});

test("requires a run store before accepting phase output", async () => {
  const pin = fixture();
  await expect(runReviewPipeline({ phase: "prepare", runId: "8".repeat(32), stdin: "{}" }, pin.config))
    .rejects.toMatchObject({ code: "review_pipeline_store_unavailable" });
});

test("refuses over-cap helper output before publishing an artifact", async () => {
  const pin = fixture();
  const store = new ReviewRunStore({ root: pin.store.root, projectRoot: pin.project, caps: { ...pin.store.caps, maxFileBytes: 300 * 1024 } });
  const cap = store.caps.maxFileBytes;
  const runId = "9".repeat(32);
  const runDir = store.runDir(pin.sessionID, runId);
  mkdirSync(runDir, { recursive: true });
  const before = readdirSync(runDir).sort();
  const { spawnExec } = await import("../src/msb.ts");
  const prefix = '{"oversized":"';
  const output = prefix + "x".repeat(cap + 1 - Buffer.byteLength(prefix) - 2) + '"}';
  await expect(runReviewPipeline({ phase: "prepare", runId, stdin: "{}" }, pin.config,
    (argv, opts) => spawnExec(argv, { ...opts, env: { PATH: process.env.PATH ?? "", FIXTURE_MODE: "oversize", OVERSIZE_BYTES: String(cap + 1) }, envMode: "replace" }),
    { store, sessionID: pin.sessionID },
  )).rejects.toMatchObject({ code: "review_pipeline_output_too_large", message: `review pipeline output exceeds per-file cap ${cap} bytes (observed ${Buffer.byteLength(output)} bytes)` });
  expect(readdirSync(runDir).sort()).toEqual(before);
});

test("returns a distinct structural rejection without a phase output on exit one", async () => {
  const pin = fixture();
  const result = await runReviewPipeline({ phase: "prepare", runId: "c".repeat(32), stdin: "{}" }, pin.config,
    async (argv, opts) => {
      const { spawnExec } = await import("../src/msb.ts");
      return spawnExec(argv, { ...opts, env: { PATH: process.env.PATH ?? "", FIXTURE_MODE: "reject" }, envMode: "replace" });
    });
  expect(result).toEqual({ outcome: "structurally_rejected", code: "review_pipeline_structurally_rejected", diagnostic: "invalid envelope" });
});

test("maps exit one with the internal-error prefix to validation_unavailable", async () => {
  const pin = fixture();
  const result = await runReviewPipeline({ phase: "prepare", runId: "f".repeat(32), stdin: "{}" }, pin.config,
    async (argv, opts) => {
      const { spawnExec } = await import("../src/msb.ts");
      return spawnExec(argv, { ...opts, env: { PATH: process.env.PATH ?? "", FIXTURE_MODE: "internal-error" }, envMode: "replace" });
    });
  expect(result).toMatchObject({ outcome: "validation_unavailable", code: "review_pipeline_validation_unavailable", diagnostic: expect.stringContaining("ce-review-validator: internal error in finalize") });
});

test("maps other exit-one diagnostics to structurally_rejected", async () => {
  const pin = fixture();
  const result = await runReviewPipeline({ phase: "prepare", runId: "1".repeat(32), stdin: "{}" }, pin.config,
    async (argv, opts) => {
      const { spawnExec } = await import("../src/msb.ts");
      return spawnExec(argv, { ...opts, env: { PATH: process.env.PATH ?? "", FIXTURE_MODE: "reject" }, envMode: "replace" });
    });
  expect(result).toMatchObject({ outcome: "structurally_rejected", code: "review_pipeline_structurally_rejected", diagnostic: "invalid envelope" });
});

test("digest mismatch refuses before spawn and unknown phases fail validation", async () => {
  const pin = fixture();
  let spawns = 0;
  const spawn: SpawnFn = async () => { spawns++; throw new Error("must not spawn"); };
  await expect(runReviewPipeline({ phase: "prepare", runId: "e".repeat(32), stdin: "{}" },
    { ...pin.config, reviewHelperSha256: "0".repeat(64) }, spawn)).rejects.toMatchObject({ code: "review_helper_digest_mismatch" });
  expect(spawns).toBe(0);
  await expect(runReviewPipeline({ phase: "unknown", runId: "e".repeat(32), stdin: "{}" }, pin.config, spawn))
    .rejects.toMatchObject({ code: "review_pipeline_phase_invalid" });
  await expect(runReviewPipeline({ phase: "screen", runId: "e".repeat(32), stdin: "{}" }, pin.config, spawn))
    .rejects.toMatchObject({ code: "review_pipeline_reviewer_invalid" });
  await expect(runReviewPipeline({ phase: "prepare", reviewer: "review-risk", runId: "e".repeat(32), stdin: "{}" }, pin.config, spawn))
    .rejects.toMatchObject({ code: "review_pipeline_reviewer_forbidden" });
  await expect(runReviewPipeline({ phase: "prepare", runId: "e".repeat(32), stdin: "x".repeat(REVIEW_PIPELINE_MAX_STDIN_BYTES + 1) }, pin.config, spawn))
    .rejects.toMatchObject({ code: "review_pipeline_stdin_too_large" });
});

test("rejects caller-supplied harness and argv fields at payload validation", () => {
  expect(() => assertPayloadKeys("reviewPipelineRun", { phase: "screen", reviewer: "review-risk", stdin: "{}", runId: "a".repeat(32), harness: "pi" })).toThrow(ValidationError);
  expect(() => assertPayloadKeys("reviewPipelineRun", { phase: "screen", reviewer: "review-risk", stdin: "{}", runId: "a".repeat(32), args: ["--evil"] })).toThrow(ValidationError);
});

test("observes exact fixed argv for all phases and rejects caller argv fields", async () => {
  const pin = fixture();
  const writer = pin.store.createRun(pin.sessionID);
  const cases = [
    ["screen", "review-risk", ["screen", "--reviewer", "review-risk", "--harness", "opencode"]],
    ["prepare", undefined, ["prepare"]],
    ["merge", undefined, ["merge"]],
    ["finalize", undefined, ["finalize"]],
  ] as const;
  for (const [phase, reviewer, argv] of cases) {
    const result = await runReviewPipeline({ phase, reviewer, runId: writer.record.runId, stdin: "{}", harness: "malicious", args: ["--evil"] } as never, pin.config, undefined, { store: pin.store, sessionID: pin.sessionID });
    expect(result.outcome).toBe("accepted");
    const name = phase === "screen" ? `phase-screen-${reviewer}.json` : `phase-${phase}.json`;
    const saved = JSON.parse(readFileSync(join(pin.store.runDir(pin.sessionID, writer.record.runId), name), "utf8")) as { argv: string[] };
    expect(saved.argv).toEqual(argv);
  }
});

test("preserves arbitrary stdin bytes and the fixture reveals their digest", async () => {
  const pin = fixture();
  const bytes = [0x7b, 0xff, 0x00, 0x80, 0x7d];
  const writer = pin.store.createRun(pin.sessionID);
  const result = await runReviewPipeline({ phase: "prepare", runId: writer.record.runId, stdin: bytes }, pin.config, undefined, { store: pin.store, sessionID: pin.sessionID });
  const expected = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  expect(result.outcome).toBe("accepted");
  const saved = JSON.parse(readFileSync(join(pin.store.runDir(pin.sessionID, writer.record.runId), "phase-prepare.json"), "utf8")) as { stdinSha256: string };
  expect(saved.stdinSha256).toBe(expected);
});

test("maps missing helper and unstartable helper to validation_unavailable", async () => {
  const pin = fixture();
  const missing = await runReviewPipeline({ phase: "prepare", runId: "2".repeat(32), stdin: "{}" },
    { reviewHelperPath: join(pin.helper, "..", "missing-helper.mjs"), reviewHelperSha256: pin.digest });
  expect(missing).toMatchObject({ outcome: "validation_unavailable", code: "review_pipeline_validation_unavailable" });
  const unstartable = await runReviewPipeline({ phase: "prepare", runId: "3".repeat(32), stdin: "{}" }, pin.config,
    async () => { throw Object.assign(new Error("spawn unavailable"), { code: "ENOENT" }); });
  expect(unstartable).toMatchObject({ outcome: "validation_unavailable", code: "review_pipeline_validation_unavailable" });
});

test("maps exit two to validation_unavailable", async () => {
  const pin = fixture();
  const { spawnExec } = await import("../src/msb.ts");
  const result = await runReviewPipeline({ phase: "merge", runId: "d".repeat(32), stdin: "{}" }, pin.config,
    (argv, opts) => spawnExec(argv, { ...opts, env: { PATH: process.env.PATH ?? "", FIXTURE_MODE: "unavailable" }, envMode: "replace" }));
  expect(result).toMatchObject({ outcome: "validation_unavailable", code: "review_pipeline_validation_unavailable" });
});
