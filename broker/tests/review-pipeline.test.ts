import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runReviewPipeline, REVIEW_PIPELINE_MAX_STDIN_BYTES, REVIEW_PIPELINE_REVIEWERS } from "../src/review-pipeline.ts";
import { INSTALLED_REVIEW_AGENTS } from "../../opencode/plugins/lib/reviewer-relay-core.ts";
import { spawnExec, type SpawnFn } from "../src/msb.ts";
import { assertPayloadKeys, assertReviewLens, ValidationError } from "../src/validation.ts";
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
  )).rejects.toMatchObject({ code: "review_pipeline_input_ref_invalid" });
  await expect(runReviewPipeline(
    { runId: writer.record.runId, phase: "merge", stdin: "{}", inputRef: "phase-prepare.json" } as never,
    pin.config, undefined, { store, sessionID } as never,
  )).rejects.toMatchObject({ code: "review_pipeline_stdin_source_conflict" });
  await expect(runReviewPipeline(
    { runId: writer.record.runId, phase: "merge", inputRef: "phase-finalize.json" } as never,
    pin.config, undefined, { store, sessionID } as never,
  )).rejects.toMatchObject({ code: "review_pipeline_merge_ref_phase_invalid" });
  await expect(runReviewPipeline(
    { runId: writer.record.runId, phase: "merge", inputRef: "unrecognized.json" } as never,
    pin.config, undefined, { store, sessionID } as never,
  )).rejects.toMatchObject({ code: "review_pipeline_input_ref_unknown" });
  expect(readdirSync(store.runDir(sessionID, writer.record.runId)).sort()).toContain("phase-prepare.json");
});

test("inputRefs validates phase, grammar, run membership, JSON, count, conflicts, and assembled byte cap", async () => {
  const pin = fixture();
  const writer = pin.store.createRun(pin.sessionID);
  const store = new ReviewRunStore({ root: pin.store.root, projectRoot: pin.project, caps: { ...pin.store.caps, maxFileBytes: 1024 * 1024 } });
  store.addArtifact(pin.sessionID, writer.record.runId, "phase-screen-correctness.json", Buffer.from("{\"ok\":true}"));
  store.addArtifact(pin.sessionID, writer.record.runId, "phase-screen-testing.json", Buffer.from("{bad"));
  store.addArtifact(pin.sessionID, writer.record.runId, "phase-screen-project-standards.json", Buffer.from('"bare string"'));
  store.addArtifact(pin.sessionID, writer.record.runId, "phase-screen-maintainability.json", Buffer.from("[]"));
  const context = { store, sessionID: pin.sessionID };
  const invoke = (payload: Record<string, unknown>) => runReviewPipeline({ runId: writer.record.runId, phase: "prepare", ...payload }, pin.config, undefined, context);

  await expect(runReviewPipeline({ phase: "merge", runId: writer.record.runId, inputRefs: ["phase-screen-correctness.json"] }, pin.config, undefined, context))
    .rejects.toMatchObject({ code: "review_pipeline_stdin_source_conflict" });
  await expect(invoke({ inputRefs: ["phase-prepare.json"] })).rejects.toMatchObject({ code: "review_pipeline_input_ref_not_screen" });
  await expect(invoke({ inputRefs: ["phase-screen-unknown.json"] })).rejects.toMatchObject({ code: "review_pipeline_input_ref_not_screen" });
  await expect(invoke({ inputRefs: ["phase-screen-adversarial.json"] })).rejects.toMatchObject({ code: "review_run_artifact_not_found" });
  await expect(invoke({ inputRefs: ["phase-screen-testing.json"] })).rejects.toMatchObject({ code: "review_pipeline_input_ref_unparseable", message: expect.stringContaining("phase-screen-testing.json") });
  await expect(invoke({ inputRefs: [] })).rejects.toMatchObject({ code: "review_pipeline_input_refs_empty" });
  await expect(invoke({ inputRefs: ["phase-screen-correctness.json", "phase-screen-correctness.json"] }))
    .rejects.toMatchObject({ code: "review_pipeline_input_ref_duplicate" });
  await expect(invoke({ inputRefs: ["phase-screen-project-standards.json"] }))
    .rejects.toMatchObject({ code: "review_pipeline_input_ref_not_object" });
  await expect(invoke({ inputRefs: ["phase-screen-maintainability.json"] }))
    .rejects.toMatchObject({ code: "review_pipeline_input_ref_not_object" });
  await expect(invoke({ inputRefs: ["phase-screen.json"] })).rejects.toMatchObject({ code: "review_pipeline_input_ref_not_screen" });
  await expect(invoke({ inputRefs: ["phase-prepare-correctness.json"] })).rejects.toMatchObject({ code: "review_pipeline_input_ref_not_screen" });
  await expect(invoke({ inputRefs: Array(17).fill("phase-screen-correctness.json") }))
    .rejects.toMatchObject({ code: "review_pipeline_input_refs_too_many", message: expect.stringContaining("16") });
  await expect(runReviewPipeline({ phase: "prepare", runId: writer.record.runId, stdin: "{}", inputRefs: ["phase-screen-correctness.json"] }, pin.config, undefined, context))
    .rejects.toMatchObject({ code: "review_pipeline_stdin_source_conflict" });
  await expect(runReviewPipeline({ phase: "prepare", runId: writer.record.runId, inputRef: "phase-screen-correctness.json", inputRefs: ["phase-screen-correctness.json"] }, pin.config, undefined, context))
    .rejects.toMatchObject({ code: "review_pipeline_stdin_source_conflict" });
  const large = Buffer.from(JSON.stringify({ value: "x".repeat(140 * 1024) }));
  store.addArtifact(pin.sessionID, writer.record.runId, "phase-screen-security.json", large);
  store.addArtifact(pin.sessionID, writer.record.runId, "phase-screen-performance.json", large);
  await expect(invoke({ inputRefs: ["phase-screen-security.json", "phase-screen-performance.json"] }))
    .rejects.toMatchObject({ code: "review_pipeline_input_refs_too_large", message: expect.stringContaining(String(REVIEW_PIPELINE_MAX_STDIN_BYTES)) });
});

test("accepts a persona-named screen artifact as a later phase inputRef", async () => {
  const pin = fixture();
  const writer = pin.store.createRun(pin.sessionID);
  writer.addArtifact("phase-screen-correctness.json", Buffer.from("{}"));
  await expect(runReviewPipeline(
    { phase: "prepare", runId: writer.record.runId, inputRef: "phase-screen-correctness.json" },
    pin.config, undefined, { store: pin.store, sessionID: pin.sessionID },
  )).resolves.toMatchObject({ outcome: "accepted", artifact: { name: "phase-prepare.json" } });
});

test("refuses a screen artifact with an unknown persona suffix", async () => {
  const pin = fixture();
  const writer = pin.store.createRun(pin.sessionID);
  await expect(runReviewPipeline(
    { phase: "prepare", runId: writer.record.runId, inputRef: "phase-screen-unknown-persona.json" },
    pin.config, undefined, { store: pin.store, sessionID: pin.sessionID },
  )).rejects.toMatchObject({ code: "review_pipeline_input_ref_unknown" });
});

test("merge preflight refuses recorded oversized artifacts before reading them", async () => {
  const pin = fixture();
  const writer = pin.store.createRun(pin.sessionID);
  pin.store.addArtifact(pin.sessionID, writer.record.runId, "phase-prepare.json", Buffer.from(JSON.stringify({ value: "x".repeat(REVIEW_PIPELINE_MAX_STDIN_BYTES) })));
  const record = pin.store.readRecord(pin.sessionID, writer.record.runId);
  const originalRunDir = pin.store.runDir.bind(pin.store);
  let artifactReadCount = 0;
  pin.store.readRecord = (() => record) as typeof pin.store.readRecord;
  pin.store.runDir = ((sessionID: string, runId: string) => { artifactReadCount++; return originalRunDir(sessionID, runId); }) as typeof pin.store.runDir;

  await expect(runReviewPipeline(
    { phase: "merge", runId: writer.record.runId, inputRef: "phase-prepare.json", adjudication: { decisions: [] } },
    pin.config, undefined, { store: pin.store, sessionID: pin.sessionID },
  )).rejects.toMatchObject({ code: "review_pipeline_composed_input_too_large" });
  expect(artifactReadCount).toBe(0);
});

test("finalize preflight refuses recorded oversized artifacts before reading them", async () => {
  const pin = fixture();
  const writer = pin.store.createRun(pin.sessionID);
  pin.store.addArtifact(pin.sessionID, writer.record.runId, "phase-prepare.json", Buffer.from("{}"));
  pin.store.addArtifact(pin.sessionID, writer.record.runId, "phase-merge.json", Buffer.from("{}"));
  pin.store.addArtifact(pin.sessionID, writer.record.runId, "phase-screen-correctness.json", Buffer.from(JSON.stringify({ value: "x".repeat(REVIEW_PIPELINE_MAX_STDIN_BYTES) })));
  const record = pin.store.readRecord(pin.sessionID, writer.record.runId);
  const originalRunDir = pin.store.runDir.bind(pin.store);
  let artifactReadCount = 0;
  pin.store.readRecord = (() => record) as typeof pin.store.readRecord;
  pin.store.runDir = ((sessionID: string, runId: string) => { artifactReadCount++; return originalRunDir(sessionID, runId); }) as typeof pin.store.runDir;

  await expect(runReviewPipeline(
    { phase: "finalize", runId: writer.record.runId, preparedRef: "phase-prepare.json", mergeRef: "phase-merge.json", dispatch_records: [], validator_lifecycle_results: [], plan_assessment: {}, parent_run_metadata: {} },
    pin.config, undefined, { store: pin.store, sessionID: pin.sessionID },
  )).rejects.toMatchObject({ code: "review_pipeline_composed_input_too_large" });
  expect(artifactReadCount).toBe(0);
});

test("finalize binds parent metadata head_sha to the resolved run head", async () => {
  const pin = fixture();
  const expectedHead = "a".repeat(40);
  const writer = pin.store.createRun(pin.sessionID, { headObjectId: expectedHead });
  pin.store.addArtifact(pin.sessionID, writer.record.runId, "phase-prepare.json", Buffer.from("{}"));
  pin.store.addArtifact(pin.sessionID, writer.record.runId, "phase-merge.json", Buffer.from("{}"));
  pin.store.addArtifact(pin.sessionID, writer.record.runId, "phase-screen-correctness.json", Buffer.from("{}"));
  const base = { phase: "finalize", runId: writer.record.runId, preparedRef: "phase-prepare.json", mergeRef: "phase-merge.json", dispatch_records: [], validator_lifecycle_results: [], plan_assessment: {}, parent_run_metadata: { branch: "master", mode: "standard" } };
  const finalize = (parent_run_metadata: Record<string, unknown>) => runReviewPipeline({ ...base, parent_run_metadata }, pin.config, undefined, { store: pin.store, sessionID: pin.sessionID });

  await expect(finalize({ branch: "master" })).resolves.toMatchObject({ outcome: "accepted" });
  const missingHeadArtifact = pin.store.readRecord(pin.sessionID, writer.record.runId).finalizeProvenance?.artifact;
  expect(missingHeadArtifact).toBeDefined();
  const missingHead = JSON.parse(readFileSync(join(pin.store.runDir(pin.sessionID, writer.record.runId), missingHeadArtifact!.name), "utf8")).input;
  expect(JSON.parse(missingHead).parent_run_metadata.head_sha).toBe(expectedHead);

  await expect(finalize({ branch: "master", head_sha: expectedHead })).resolves.toMatchObject({ outcome: "accepted" });
  await expect(finalize({ branch: "master", head_sha: "b".repeat(40) })).rejects.toMatchObject({ code: "review_pipeline_parent_head_sha_mismatch" });
});

test("refuses a composed merge payload larger than the inline stdin cap", async () => {
  const pin = fixture();
  const writer = pin.store.createRun(pin.sessionID);
  writer.addArtifact("phase-prepare.json", Buffer.from(JSON.stringify({ value: "x".repeat(REVIEW_PIPELINE_MAX_STDIN_BYTES) })));
  await expect(runReviewPipeline(
    { phase: "merge", runId: writer.record.runId, inputRef: "phase-prepare.json", adjudication: { decisions: [] } },
    pin.config, undefined, { store: pin.store, sessionID: pin.sessionID },
  )).rejects.toMatchObject({ code: "review_pipeline_composed_input_too_large", message: expect.stringContaining(`cap ${REVIEW_PIPELINE_MAX_STDIN_BYTES} bytes`) });
});

test("REVIEW_PIPELINE_REVIEWERS contains the exact ce:review persona catalog", () => {
  expect(REVIEW_PIPELINE_REVIEWERS).toEqual([
    "correctness", "testing", "project-standards", "maintainability", "security", "performance",
    "api-contract", "data-migrations", "reliability", "adversarial", "cli-readiness", "previous-comments",
    "kieran-typescript",
  ]);
});

test("accepts ce:review personas and refuses native 4R names on the pipeline surface", async () => {
  const pin = fixture();
  const writer = pin.store.createRun(pin.sessionID);
  await runReviewPipeline({ phase: "screen", reviewer: "correctness", runId: writer.record.runId, stdin: "{}" }, pin.config, undefined, { store: pin.store, sessionID: pin.sessionID });
  expect(pin.store.readRecord(pin.sessionID, writer.record.runId).artifacts.map(({ name }) => name)).toContain("phase-screen-correctness.json");
  await expect(runReviewPipeline({ phase: "screen", reviewer: "review-risk", runId: writer.record.runId, stdin: "{}" }, pin.config))
    .rejects.toMatchObject({ code: "review_pipeline_reviewer_invalid" });
});

test("preserves all four native review lenses and relay agents independently of pipeline personas", () => {
  const lenses = ["review-risk", "review-resilience", "review-readability", "review-reliability"] as const;
  for (const lens of lenses) expect(() => assertReviewLens(lens)).not.toThrow();
  expect(() => assertReviewLens("correctness")).toThrow(ValidationError);
  expect(INSTALLED_REVIEW_AGENTS).toEqual(expect.arrayContaining(lenses));
  expect(INSTALLED_REVIEW_AGENTS).toEqual(expect.arrayContaining(["review-risk", "review-resilience", "review-readability", "review-reliability"]));
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
  const result = await runReviewPipeline({ phase: "screen", reviewer: "correctness", runId: writer.record.runId, stdin: payload }, pin.config, undefined, { store: pin.store, sessionID: pin.sessionID });
  expect(result).toMatchObject({ outcome: "accepted", artifact: { name: "phase-screen-correctness.json" } });
  expect(JSON.parse(readFileSync(join(pin.store.runDir(pin.sessionID, writer.record.runId), "phase-screen-correctness.json"), "utf8"))).toEqual({ argv: ["screen", "--reviewer", "correctness", "--harness", "opencode"], input: payload, stdinSha256: createHash("sha256").update(payload).digest("hex") });
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
  await expect(runReviewPipeline({ phase: "prepare", reviewer: "correctness", runId: "e".repeat(32), stdin: "{}" }, pin.config, spawn))
    .rejects.toMatchObject({ code: "review_pipeline_reviewer_forbidden" });
  await expect(runReviewPipeline({ phase: "prepare", runId: "e".repeat(32), stdin: "x".repeat(REVIEW_PIPELINE_MAX_STDIN_BYTES + 1) }, pin.config, spawn))
    .rejects.toMatchObject({ code: "review_pipeline_stdin_too_large" });
});

test("rejects caller-supplied harness and argv fields at payload validation", () => {
  expect(() => assertPayloadKeys("reviewPipelineRun", { phase: "screen", reviewer: "correctness", stdin: "{}", runId: "a".repeat(32), harness: "pi" })).toThrow(ValidationError);
  expect(() => assertPayloadKeys("reviewPipelineRun", { phase: "screen", reviewer: "correctness", stdin: "{}", runId: "a".repeat(32), args: ["--evil"] })).toThrow(ValidationError);
});

test("observes exact fixed argv for all phases and rejects caller argv fields", async () => {
  const pin = fixture();
  const writer = pin.store.createRun(pin.sessionID, { headObjectId: "a".repeat(40) });
  writer.addArtifact("phase-screen-correctness.json", Buffer.from("{}"));
  writer.addArtifact("phase-prepare.json", Buffer.from("{}"));
  writer.addArtifact("phase-merge.json", Buffer.from("{}"));
  const envelopes = { dispatch_records: [], validator_lifecycle_results: [], plan_assessment: { verdict: "complete", residual_actionable_work: [], advisory_outputs: [] }, parent_run_metadata: { run_id: writer.record.runId, branch: "master", head_sha: "a".repeat(40), mode: "standard", harness: "opencode", timestamps: { completed_at: "now" }, applied_fixes: [], selected_dispatches: [], validation: [] } };
  const cases = [
    [{ phase: "screen", reviewer: "correctness", stdin: "{}" }, ["screen", "--reviewer", "correctness", "--harness", "opencode"]],
    [{ phase: "prepare", stdin: "{}" }, ["prepare"]],
    [{ phase: "merge", inputRef: "phase-prepare.json", adjudication: { decisions: [] } }, ["merge"]],
    [{ phase: "finalize", preparedRef: "phase-prepare.json", mergeRef: "phase-merge.json", ...envelopes }, ["finalize"]],
  ] as const;
  for (const [fields, argv] of cases) {
    const phase = fields.phase;
    const result = await runReviewPipeline({ ...fields, runId: writer.record.runId, harness: "malicious", args: ["--evil"] } as never, pin.config, undefined, { store: pin.store, sessionID: pin.sessionID });
    expect(result.outcome).toBe("accepted");
    const name = phase === "screen" ? "phase-screen-correctness.json" : `phase-${phase}.json`;
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
  const result = await runReviewPipeline({ phase: "prepare", runId: "d".repeat(32), stdin: "{}" }, pin.config,
    (argv, opts) => spawnExec(argv, { ...opts, env: { PATH: process.env.PATH ?? "", FIXTURE_MODE: "unavailable" }, envMode: "replace" }));
  expect(result).toMatchObject({ outcome: "validation_unavailable", code: "review_pipeline_validation_unavailable" });
});

test("refuses helper-owned overrides, wrong phase refs, duplicates, and oversized caller envelopes", async () => {
  const pin = fixture();
  const writer = pin.store.createRun(pin.sessionID);
  const context = { store: pin.store, sessionID: pin.sessionID };
  for (const field of ["prepared", "merge", "screen_results"] as const) {
    await expect(runReviewPipeline({ phase: "merge", runId: writer.record.runId, [field]: {}, inputRef: "phase-prepare.json", adjudication: { decisions: [] } }, pin.config, undefined, context))
      .rejects.toMatchObject({ code: `review_pipeline_${field}_override_forbidden` });
  }
  writer.addArtifact("phase-screen-correctness.json", Buffer.from('{"screen":true}'));
  writer.addArtifact("phase-prepare.json", Buffer.from('{"prepared":true}'));
  writer.addArtifact("phase-merge.json", Buffer.from('{"merged":true}'));
  await expect(runReviewPipeline({ phase: "merge", runId: writer.record.runId, inputRef: "phase-screen-correctness.json", adjudication: { decisions: [] } }, pin.config, undefined, context))
    .rejects.toMatchObject({ code: "review_pipeline_merge_ref_phase_invalid" });
  await expect(runReviewPipeline({ phase: "finalize", runId: writer.record.runId, preparedRef: "phase-prepare.json", mergeRef: "phase-prepare.json" }, pin.config, undefined, context))
    .rejects.toMatchObject({ code: "review_pipeline_input_ref_duplicate" });
  await expect(runReviewPipeline({ phase: "finalize", runId: writer.record.runId, preparedRef: "phase-prepare.json", mergeRef: "phase-merge.json", dispatch_records: [{ text: "x".repeat(33 * 1024) }], validator_lifecycle_results: [], plan_assessment: {}, parent_run_metadata: {} }, pin.config, undefined, context))
    .rejects.toMatchObject({ code: "review_pipeline_dispatch_records_too_large", message: expect.stringContaining("observed") });
  await expect(runReviewPipeline({ phase: "finalize", runId: writer.record.runId, preparedRef: "phase-prepare.json", mergeRef: "phase-merge.json", dispatch_records: [{ x: "a".repeat(20 * 1024) }], validator_lifecycle_results: [{ x: "b".repeat(20 * 1024) }], plan_assessment: { x: "c".repeat(20 * 1024) }, parent_run_metadata: { x: "d".repeat(20 * 1024) } }, pin.config, undefined, context))
    .rejects.toMatchObject({ code: "review_pipeline_caller_envelopes_too_large", message: expect.stringContaining("total cap") });
  await expect(runReviewPipeline({ phase: "finalize", runId: writer.record.runId, preparedRef: "phase-prepare.json", mergeRef: "phase-merge.json", dispatch_records: [{ x: "a".repeat(20 * 1024) }], validator_lifecycle_results: [{ x: "b".repeat(20 * 1024) }], plan_assessment: { x: "c".repeat(20 * 1024) }, parent_run_metadata: { x: "d".repeat(20 * 1024) } }, pin.config, undefined, context))
    .rejects.toMatchObject({ code: "review_pipeline_caller_envelopes_too_large", message: expect.stringContaining("total cap") });
});

test("refuses helper-owned overrides, wrong phase refs, duplicates, and oversized caller envelopes", async () => {
  const pin = fixture();
  const writer = pin.store.createRun(pin.sessionID);
  const context = { store: pin.store, sessionID: pin.sessionID };
  for (const field of ["prepared", "merge", "screen_results"] as const) {
    await expect(runReviewPipeline({ phase: "merge", runId: writer.record.runId, [field]: {}, inputRef: "phase-prepare.json", adjudication: { decisions: [] } }, pin.config, undefined, context))
      .rejects.toMatchObject({ code: `review_pipeline_${field}_override_forbidden` });
  }
  writer.addArtifact("phase-screen-correctness.json", Buffer.from('{"screen":true}'));
  writer.addArtifact("phase-prepare.json", Buffer.from('{"prepared":true}'));
  writer.addArtifact("phase-merge.json", Buffer.from('{"merged":true}'));
  await expect(runReviewPipeline({ phase: "merge", runId: writer.record.runId, inputRef: "phase-screen-correctness.json", adjudication: { decisions: [] } }, pin.config, undefined, context))
    .rejects.toMatchObject({ code: "review_pipeline_merge_ref_phase_invalid" });
  await expect(runReviewPipeline({ phase: "finalize", runId: writer.record.runId, preparedRef: "phase-prepare.json", mergeRef: "phase-prepare.json" }, pin.config, undefined, context))
    .rejects.toMatchObject({ code: "review_pipeline_input_ref_duplicate" });
  await expect(runReviewPipeline({ phase: "finalize", runId: writer.record.runId, preparedRef: "phase-prepare.json", mergeRef: "phase-merge.json", dispatch_records: [{ text: "x".repeat(33 * 1024) }], validator_lifecycle_results: [], plan_assessment: {}, parent_run_metadata: {} }, pin.config, undefined, context))
    .rejects.toMatchObject({ code: "review_pipeline_dispatch_records_too_large", message: expect.stringContaining("observed") });
  await expect(runReviewPipeline({ phase: "finalize", runId: writer.record.runId, preparedRef: "phase-prepare.json", mergeRef: "phase-merge.json", dispatch_records: [{ x: "a".repeat(20 * 1024) }], validator_lifecycle_results: [{ x: "b".repeat(20 * 1024) }], plan_assessment: { x: "c".repeat(20 * 1024) }, parent_run_metadata: { x: "d".repeat(20 * 1024) } }, pin.config, undefined, context))
    .rejects.toMatchObject({ code: "review_pipeline_caller_envelopes_too_large", message: expect.stringContaining("total cap") });
  await expect(runReviewPipeline({ phase: "finalize", runId: writer.record.runId, preparedRef: "phase-prepare.json", mergeRef: "phase-merge.json", dispatch_records: [{ x: "a".repeat(20 * 1024) }], validator_lifecycle_results: [{ x: "b".repeat(20 * 1024) }], plan_assessment: { x: "c".repeat(20 * 1024) }, parent_run_metadata: { x: "d".repeat(20 * 1024) } }, pin.config, undefined, context))
    .rejects.toMatchObject({ code: "review_pipeline_caller_envelopes_too_large", message: expect.stringContaining("total cap") });
});
