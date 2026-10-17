import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runReviewPipeline, REVIEW_PIPELINE_MAX_STDIN_BYTES } from "../src/review-pipeline.ts";
import { spawnExec, type SpawnFn } from "../src/msb.ts";
import { assertPayloadKeys, ValidationError } from "../src/validation.ts";

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
if (mode === 'unavailable') process.exit(2);
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input: input.toString('utf8'), stdinSha256: createHash('sha256').update(input).digest('hex') }));
`);
  chmodSync(helper, 0o700);
  const digest = createHash("sha256").update(readFileSync(helper)).digest("hex");
  return { helper, digest, config: { reviewHelperPath: helper, reviewHelperSha256: digest, reviewHelperInterpreter: process.execPath } };
}

test("runs a mode-0600 pinned helper through its configured interpreter", async () => {
  const pin = fixture();
  chmodSync(pin.helper, 0o600);
  const config = { ...pin.config, reviewHelperInterpreter: process.execPath };
  let observedArgv: string[] = [];
  const result = await runReviewPipeline(
    { phase: "prepare", runId: "a".repeat(32), stdin: "{}" }, config,
    (argv, options) => { observedArgv = argv; return spawnExec(argv, options); },
  );
  expect(observedArgv).toEqual([process.execPath, pin.helper, "prepare"]);
  expect(result).toEqual({ outcome: "accepted", output: {
    argv: ["prepare"], input: "{}", stdinSha256: createHash("sha256").update("{}").digest("hex"),
  } });
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
  const result = await runReviewPipeline({ phase: "screen", reviewer: "review-risk", runId: "a".repeat(32), stdin: payload }, pin.config);
  expect(result).toEqual({ outcome: "accepted", output: { argv: ["screen", "--reviewer", "review-risk", "--harness", "opencode"], input: payload, stdinSha256: createHash("sha256").update(payload).digest("hex") } });
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

test("returns a distinct structural rejection without a phase output on exit one", async () => {
  const pin = fixture();
  const result = await runReviewPipeline({ phase: "prepare", runId: "c".repeat(32), stdin: "{}" }, pin.config,
    async (argv, opts) => {
      const { spawnExec } = await import("../src/msb.ts");
      return spawnExec(argv, { ...opts, env: { PATH: process.env.PATH ?? "", FIXTURE_MODE: "reject" }, envMode: "replace" });
    });
  expect(result).toEqual({ outcome: "structurally_rejected", code: "review_pipeline_structurally_rejected", diagnostic: "invalid envelope" });
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
  const cases = [
    ["screen", "review-risk", ["screen", "--reviewer", "review-risk", "--harness", "opencode"]],
    ["prepare", undefined, ["prepare"]],
    ["merge", undefined, ["merge"]],
    ["finalize", undefined, ["finalize"]],
  ] as const;
  for (const [phase, reviewer, argv] of cases) {
    const result = await runReviewPipeline({ phase, reviewer, runId: "f".repeat(32), stdin: "{}", harness: "malicious", args: ["--evil"] } as never, pin.config);
    expect((result as { outcome: string; output: { argv: string[] } }).output.argv).toEqual(argv);
  }
});

test("preserves arbitrary stdin bytes and the fixture reveals their digest", async () => {
  const pin = fixture();
  const bytes = [0x7b, 0xff, 0x00, 0x80, 0x7d];
  const result = await runReviewPipeline({ phase: "prepare", runId: "1".repeat(32), stdin: bytes }, pin.config);
  const expected = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  expect((result as { output: { stdinSha256: string } }).output.stdinSha256).toBe(expected);
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
