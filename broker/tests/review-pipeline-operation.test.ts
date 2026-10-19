import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { BrokerServer } from "../src/server.ts";
import { ReviewRunStore, reviewRunStoreOptions } from "../src/review-run.ts";
import type { BrokerRequestEnvelope } from "../src/types.ts";

const SESSION_ID = "bound-orchestrator";
const roots: string[] = [];
const rootBase = ["/var/tmp", process.env.HOME ?? ""].find((candidate) => {
  try { return candidate && !realpathSync(candidate).startsWith(`${realpathSync(tmpdir())}/`); }
  catch { return false; }
});
if (!rootBase) throw new Error("no writable test base outside $TMPDIR");
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function operationFixture(caps?: { maxBytes: number; maxFileBytes: number; maxPerSession: number }) {
  const root = mkdtempSync(join(rootBase!, "review-pipeline-operation-"));
  roots.push(root);
  const project = join(root, "project");
  const secondProject = join(root, "second-project");
  mkdirSync(project);
  mkdirSync(secondProject);
  for (const projectRoot of [project, secondProject]) {
    const git = Bun.spawnSync(["git", "init", "-q"], { cwd: projectRoot, env: { PATH: process.env.PATH ?? "" } });
    expect(git.exitCode).toBe(0);
  }
  const helperPath = join(root, "review-helper.js");
  const auditPath = join(root, "spawn-audit.jsonl");
  writeFileSync(helperPath, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(auditPath)}, JSON.stringify([process.execPath, process.argv[1], ...args]) + "\\n");
if (args[0] === "artifact") process.exit(0);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  if (args[0] === "finalize" && input.includes("reject-finalize")) process.exit(1);
  const output = (args[0] === "finalize" && !input.includes("capture-finalize-input")) || input.includes("writing-wrapper")
    ? { kind: "writing", artifact: { verdict: "approved" } }
    : { phase: args[0], input };
  process.stdout.write(JSON.stringify(output));
});
`);
  const helperSha256 = createHash("sha256").update(readFileSync(helperPath)).digest("hex");
  const reviewRunRoot = join(root, "review-runs");
  const config = defaultConfig({
    stateDir: join(root, "state"), reviewRunRoot, reviewHelperPath: helperPath,
    reviewHelperSha256: helperSha256, reviewHelperInterpreter: process.execPath,
    ...(caps ? { reviewRunMaxBytes: caps.maxBytes, reviewRunMaxFileBytes: caps.maxFileBytes, reviewRunMaxPerSession: caps.maxPerSession } : {}),
    projects: [{ id: "approved", path: project }, { id: "approved-second", path: secondProject }], readOnlyAgents: ["gentle-orchestrator"],
  });
  const server = new BrokerServer(config);
  const internals = server as unknown as {
    ctx: { store: { touch(id: string, patch: Record<string, unknown>): unknown } };
    dispatch(req: BrokerRequestEnvelope): Promise<unknown>;
  };
  internals.ctx.store.touch(SESSION_ID, { agent: "gentle-orchestrator", state: "HOST_READ_ONLY" });
  return { root, project, secondProject, helperPath, auditPath, reviewRunRoot, config, internals, store: new ReviewRunStore({ root: reviewRunRoot, projectRoot: project }) };
}

function finalizeInputs(env: ReturnType<typeof operationFixture>, runId: string, marker?: string) {
  env.store.addArtifact(SESSION_ID, runId, "phase-screen-correctness.json", Buffer.from(JSON.stringify({ phase: "screen", input: "screen" })));
  env.store.addArtifact(SESSION_ID, runId, "phase-prepare.json", Buffer.from(JSON.stringify({ phase: "prepare", groups: [] })));
  env.store.addArtifact(SESSION_ID, runId, "phase-merge.json", Buffer.from(JSON.stringify({ phase: "merge", decisions: [] })));
  return {
    preparedRef: "phase-prepare.json", mergeRef: "phase-merge.json",
    dispatch_records: [{ reviewer: "correctness", status: "completed", ...(marker ? { marker } : {}) }],
    validator_lifecycle_results: [{ validator: "unit", status: "passed" }],
    plan_assessment: { verdict: "complete", residual_actionable_work: [], advisory_outputs: [] },
    parent_run_metadata: { run_id: runId, branch: "master", head_sha: env.store.readRecord(SESSION_ID, runId).headObjectId, mode: "standard", harness: "opencode", timestamps: { completed_at: "2026-10-19T00:00:00.000Z" }, applied_fixes: [], selected_dispatches: [], validation: [] },
  };
}

test("shared review store mapping includes root, denied prefixes, and every configured cap", () => {
  const config = defaultConfig({ reviewRunRoot: "/var/tmp/review-runs", reviewRunDeniedPrefixes: ["/var/tmp/denied"], reviewRunMaxBytes: 4097, reviewRunMaxFileBytes: 513, reviewRunMaxPerSession: 7 });
  expect(reviewRunStoreOptions(config)).toEqual({
    root: "/var/tmp/review-runs",
    deniedPrefixes: ["/var/tmp/denied"],
    caps: { maxBytes: 4097, maxFileBytes: 513, maxPerSession: 7 },
  });
});

test("all three service builders use the shared review-store mapping; persist caps are mapping-only observable", () => {
  const serviceSource = readFileSync(new URL("../src/service.ts", import.meta.url), "utf8");
  expect(serviceSource.match(/reviewRunStoreOptions\(ctx\.config\)/g)).toHaveLength(3);
  expect(serviceSource.match(/new ReviewRunStore\(/g)).toHaveLength(3);
  expect(serviceSource.match(/new ReviewRunStore\(\{\s*\.\.\.reviewRunStoreOptions\(ctx\.config\),\s*projectRoot\s*\}\)/g)).toHaveLength(3);
});

test("pipeline dispatch enforces the configured review artifact cap", async () => {
  const env = operationFixture({ maxBytes: 4097, maxFileBytes: 64, maxPerSession: 7 });
  const writer = env.store.createRun(SESSION_ID);
  await expect(env.internals.dispatch({
    version: 1, id: "pipeline-cap", operation: "reviewPipelineRun", sessionID: SESSION_ID,
    payload: { projectDir: env.project, phase: "prepare", runId: writer.record.runId, stdin: "x".repeat(128) },
  })).rejects.toThrow(/per-file cap 64 bytes \(observed .* bytes\)/);
});

test("materialize dispatch enforces the configured review artifact cap", async () => {
  const env = operationFixture({ maxBytes: 4097, maxFileBytes: 64, maxPerSession: 7 });
  writeFileSync(join(env.project, "large.txt"), "materialized content that exceeds the configured artifact byte cap\n");
  expect(Bun.spawnSync(["git", "add", "large.txt"], { cwd: env.project }).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], { cwd: env.project }).exitCode).toBe(0);
  writeFileSync(join(env.project, "large.txt"), "updated materialized content that exceeds the configured artifact byte cap\n");
  expect(Bun.spawnSync(["git", "add", "large.txt"], { cwd: env.project }).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "update"], { cwd: env.project }).exitCode).toBe(0);
  await expect(env.internals.dispatch({
    version: 1, id: "materialize-cap", operation: "reviewMaterialize", sessionID: SESSION_ID,
    payload: { projectDir: env.project, baseRef: "HEAD^", headRef: "HEAD" },
  })).rejects.toThrow(/is \d+ bytes, over the per-file cap of 64/);
});

test("persist dispatch forwards configured helper path, digest, and interpreter to validation", async () => {
  const env = operationFixture();
  const runs = [env.store.createRun(SESSION_ID), env.store.createRun(SESSION_ID)];
  let finalizeRef = "";
  for (const writer of runs) {
    const result = await env.internals.dispatch({
      version: 1, id: `finalize-${writer.record.runId}`, operation: "reviewPipelineRun", sessionID: SESSION_ID,
      payload: { projectDir: env.project, phase: "finalize", runId: writer.record.runId, ...finalizeInputs(env, writer.record.runId) },
    }) as { outcome: string; artifact: { name: string } };
    expect(result.outcome).toBe("accepted");
    expect(result.artifact.name).toBe("phase-finalize.json");
    expect(readFileSync(join(env.store.runDir(SESSION_ID, writer.record.runId), result.artifact.name), "utf8"))
      .toBe(JSON.stringify({ kind: "writing", artifact: { verdict: "approved" } }));
    finalizeRef = result.artifact.name;
  }
  const selected = runs[1]!;
  const result = await env.internals.dispatch({
    version: 1, id: "persist-finalize", operation: "reviewPersist", sessionID: SESSION_ID,
    payload: { projectDir: env.project, runId: selected.record.runId, finalizeRef },
  }) as { outcome: string; validation: { status: string } };
  expect(result.outcome).toBe("persisted");
  expect(result.validation.status).not.toBe("unavailable");
  const summaryPath = join(env.project, ".context", "systematic", "ce-review", selected.record.runId, "review-summary.json");
  expect(existsSync(summaryPath)).toBe(true);
  expect(JSON.parse(readFileSync(summaryPath, "utf8"))).toMatchObject({ verdict: "approved", schema_version: 1 });
  const spawns = readFileSync(env.auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  expect(spawns).toContainEqual([process.execPath, env.helperPath, "artifact", `.context/systematic/ce-review/${selected.record.runId}/review-summary.json`]);
  expect(existsSync(join(env.store.runDir(SESSION_ID, selected.record.runId), "staging", `.context/systematic/ce-review/${selected.record.runId}/review-summary.json`))).toBe(true);
  expect(env.config.reviewHelperPath).toBe(env.helperPath);
  expect(env.config.reviewHelperSha256).toBe(createHash("sha256").update(readFileSync(env.helperPath)).digest("hex"));
  expect(env.config.reviewHelperInterpreter).toBe(process.execPath);
});

test("persist refuses a run created in project A when requested for project B", async () => {
  const env = operationFixture();
  writeFileSync(join(env.project, "source.txt"), "project A fixture\n");
  expect(Bun.spawnSync(["git", "add", "source.txt"], { cwd: env.project }).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], { cwd: env.project }).exitCode).toBe(0);
  const materialized = await env.internals.dispatch({
    version: 1, id: "materialize-project-a", operation: "reviewMaterialize", sessionID: SESSION_ID,
    payload: { projectDir: env.project, baseRef: "HEAD" },
  }) as { runId: string };
  const phase = await env.internals.dispatch({
    version: 1, id: "project-a-finalize", operation: "reviewPipelineRun", sessionID: SESSION_ID,
    payload: { projectDir: env.project, phase: "finalize", runId: materialized.runId, ...finalizeInputs(env, materialized.runId) },
  }) as { artifact: { name: string } };
  await expect(env.internals.dispatch({
    version: 1, id: "project-b-persist", operation: "reviewPersist", sessionID: SESSION_ID,
    payload: { projectDir: env.secondProject, runId: materialized.runId, finalizeRef: phase.artifact.name },
  })).rejects.toMatchObject({ code: "review_persist_project_mismatch" });
  expect(existsSync(join(env.secondProject, ".context"))).toBe(false);
});

test("persist rejects a writing-shaped non-finalize artifact as finalize provenance", async () => {
  const env = operationFixture();
  const writer = env.store.createRun(SESSION_ID);
  const phase = await env.internals.dispatch({
    version: 1, id: "prepare-writing-wrapper", operation: "reviewPipelineRun", sessionID: SESSION_ID,
    payload: { projectDir: env.project, phase: "prepare", runId: writer.record.runId, stdin: "writing-wrapper" },
  }) as { artifact: { name: string } };
  await expect(env.internals.dispatch({
    version: 1, id: "persist-prepare", operation: "reviewPersist", sessionID: SESSION_ID,
    payload: { projectDir: env.project, runId: writer.record.runId, finalizeRef: phase.artifact.name },
  })).rejects.toMatchObject({ code: "review_persist_finalize_provenance_missing" });
  expect(existsSync(join(env.project, ".context"))).toBe(false);
});

test("persist requires finalizeRef to equal the recorded finalize artifact", async () => {
  const env = operationFixture();
  const writer = env.store.createRun(SESSION_ID);
  await env.internals.dispatch({
    version: 1, id: "finalize-for-ref", operation: "reviewPipelineRun", sessionID: SESSION_ID,
    payload: { projectDir: env.project, phase: "finalize", runId: writer.record.runId, ...finalizeInputs(env, writer.record.runId) },
  });
  await expect(env.internals.dispatch({
    version: 1, id: "persist-wrong-ref", operation: "reviewPersist", sessionID: SESSION_ID,
    payload: { projectDir: env.project, runId: writer.record.runId, finalizeRef: "phase-prepare.json" },
  })).rejects.toMatchObject({ code: "review_persist_finalize_ref_mismatch" });
  expect(existsSync(join(env.project, ".context"))).toBe(false);
});

test("persist refuses finalize bytes changed after publication", async () => {
  const env = operationFixture();
  const writer = env.store.createRun(SESSION_ID);
  const phase = await env.internals.dispatch({
    version: 1, id: "finalize-for-tamper", operation: "reviewPipelineRun", sessionID: SESSION_ID,
    payload: { projectDir: env.project, phase: "finalize", runId: writer.record.runId, ...finalizeInputs(env, writer.record.runId) },
  }) as { artifact: { name: string } };
  writeFileSync(join(env.store.runDir(SESSION_ID, writer.record.runId), phase.artifact.name), JSON.stringify({ kind: "writing", artifact: { verdict: "changed" } }), { mode: 0o600 });
  await expect(env.internals.dispatch({
    version: 1, id: "persist-tampered-finalize", operation: "reviewPersist", sessionID: SESSION_ID,
    payload: { projectDir: env.project, runId: writer.record.runId, finalizeRef: phase.artifact.name },
  })).rejects.toMatchObject({ code: "review_persist_finalize_digest_mismatch" });
});

test("persist refuses provenance whose recorded phase is not finalize", async () => {
  const env = operationFixture();
  const writer = env.store.createRun(SESSION_ID);
  const phase = await env.internals.dispatch({
    version: 1, id: "finalize-for-phase-check", operation: "reviewPipelineRun", sessionID: SESSION_ID,
    payload: { projectDir: env.project, phase: "finalize", runId: writer.record.runId, ...finalizeInputs(env, writer.record.runId) },
  }) as { artifact: { name: string } };
  const metadataPath = join(env.store.runDir(SESSION_ID, writer.record.runId), "metadata.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { finalizeProvenance: { phase: string } };
  metadata.finalizeProvenance.phase = "prepare";
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await expect(env.internals.dispatch({
    version: 1, id: "persist-wrong-phase", operation: "reviewPersist", sessionID: SESSION_ID,
    payload: { projectDir: env.project, runId: writer.record.runId, finalizeRef: phase.artifact.name },
  })).rejects.toMatchObject({ code: "review_persist_finalize_phase_invalid" });
});

test("persist refuses finalize phase outcomes that were not accepted", async () => {
  const env = operationFixture();
  const writer = env.store.createRun(SESSION_ID);
  await expect(env.internals.dispatch({
    version: 1, id: "rejected-finalize", operation: "reviewPipelineRun", sessionID: SESSION_ID,
    payload: { projectDir: env.project, phase: "finalize", runId: writer.record.runId, ...finalizeInputs(env, writer.record.runId, "reject-finalize") },
  })).resolves.toMatchObject({ outcome: "structurally_rejected" });
  await expect(env.internals.dispatch({
    version: 1, id: "persist-rejected-finalize", operation: "reviewPersist", sessionID: SESSION_ID,
    payload: { projectDir: env.project, runId: writer.record.runId, finalizeRef: "phase-finalize.json" },
  })).rejects.toMatchObject({ code: "review_persist_finalize_outcome_invalid" });
  expect(existsSync(join(env.project, ".context"))).toBe(false);
});

test("prepare dispatch assembles two screened returns from inputRefs in helper stdin", async () => {
  const env = operationFixture();
  const writer = env.store.createRun(SESSION_ID);
  const refs = [];
  for (const reviewer of ["correctness", "testing"] as const) {
    const screened = await env.internals.dispatch({
      version: 1, id: `screen-${reviewer}`, operation: "reviewPipelineRun", sessionID: SESSION_ID,
      payload: { projectDir: env.project, phase: "screen", reviewer, runId: writer.record.runId, stdin: `return-${reviewer}` },
    }) as { artifact: { name: string } };
    refs.push(screened.artifact.name);
  }
  const prepared = await env.internals.dispatch({
    version: 1, id: "prepare-aggregate", operation: "reviewPipelineRun", sessionID: SESSION_ID,
    payload: { projectDir: env.project, phase: "prepare", runId: writer.record.runId, inputRefs: refs, selected_dispatches: [{ persona: "correctness" }, { persona: "testing" }] },
  }) as { outcome: string; artifact: { name: string } };
  expect(prepared.outcome).not.toBe("structurally_rejected");
  expect(prepared.artifact.name).toBe("phase-prepare.json");
  const helperOutput = JSON.parse(readFileSync(join(env.store.runDir(SESSION_ID, writer.record.runId), prepared.artifact.name), "utf8")) as { input: string };
  expect(JSON.parse(helperOutput.input)).toEqual({
    screen_results: [
      { reviewer: "correctness", result: { phase: "screen", input: "return-correctness" } },
      { reviewer: "testing", result: { phase: "screen", input: "return-testing" } },
    ],
    selected_dispatches: [{ persona: "correctness" }, { persona: "testing" }],
  });
  expect(JSON.parse(readFileSync(env.auditPath, "utf8").trim().split("\n").at(-1)!)).toEqual([process.execPath, env.helperPath, "prepare"]);
});

test("dispatch composes merge and finalize stdin from same-run artifacts", async () => {
  const env = operationFixture();
  const writer = env.store.createRun(SESSION_ID, { headObjectId: "a".repeat(40) });
  const runDir = env.store.runDir(SESSION_ID, writer.record.runId);
  const dispatch = (id: string, fields: Record<string, unknown>) => env.internals.dispatch({ version: 1, id, operation: "reviewPipelineRun", sessionID: SESSION_ID, payload: { projectDir: env.project, runId: writer.record.runId, ...fields } });
  await dispatch("screen-c", { phase: "screen", reviewer: "correctness", stdin: '{"screened":"c"}' });
  await dispatch("screen-t", { phase: "screen", reviewer: "testing", stdin: '{"screened":"t"}' });
  await dispatch("prepare", { phase: "prepare", inputRefs: ["phase-screen-correctness.json", "phase-screen-testing.json"], selected_dispatches: [{ persona: "correctness" }, { persona: "testing" }] });
  const adjudication = { decisions: [{ finding_id: "f1", decision: "accept" }] };
  await dispatch("merge", { phase: "merge", inputRef: "phase-prepare.json", adjudication });
  const envelopes = {
    dispatch_records: [{ reviewer: "correctness", status: "completed" }], validator_lifecycle_results: [{ validator: "unit", status: "passed" }],
    plan_assessment: { verdict: "complete", residual_actionable_work: [], advisory_outputs: ["capture-finalize-input"] },
    parent_run_metadata: { run_id: writer.record.runId, branch: "master", head_sha: "a".repeat(40), mode: "standard", harness: "opencode", timestamps: { completed_at: "now" }, applied_fixes: [], selected_dispatches: [], validation: [] },
  };
  await dispatch("finalize", { phase: "finalize", preparedRef: "phase-prepare.json", mergeRef: "phase-merge.json", ...envelopes });
  const screenResults = ["phase-screen-correctness.json", "phase-screen-testing.json"].map((ref, index) => ({
    reviewer: ["correctness", "testing"][index]!,
    result: JSON.parse(readFileSync(join(runDir, ref), "utf8")),
  }));
  const prepared = JSON.parse(readFileSync(join(runDir, "phase-prepare.json"), "utf8"));
  const merged = JSON.parse(readFileSync(join(runDir, "phase-merge.json"), "utf8"));
  const received = readFileSync(env.auditPath, "utf8").trim().split("\n").map((row) => JSON.parse(row) as string[]).slice(-3).map((args) => {
    const phase = args[2]!;
    return JSON.parse((JSON.parse(readFileSync(join(runDir, `phase-${phase}.json`), "utf8")) as { input: string }).input);
  });
  expect(received).toEqual([
    { screen_results: screenResults, selected_dispatches: [{ persona: "correctness" }, { persona: "testing" }] }, { prepared, adjudication },
    { merge: merged, prepared, screen_results: screenResults, ...envelopes },
  ]);
  for (const field of ["prepared", "merge", "screen_results"] as const) {
    await expect(dispatch(`override-${field}`, { phase: "merge", inputRef: "phase-prepare.json", adjudication: { decisions: [] }, [field]: {} }))
      .rejects.toMatchObject({ code: `review_pipeline_${field}_override_forbidden` });
  }
});

test("reviewMaterialize dispatch rejects contextLines above one hundred", async () => {
  const env = operationFixture();
  await expect(env.internals.dispatch({
    version: 1, id: "context-lines-over-limit", operation: "reviewMaterialize", sessionID: SESSION_ID,
    payload: { projectDir: env.project, baseRef: "HEAD", contextLines: 101 },
  })).rejects.toThrow("contextLines must be an integer from 0 through 100");
});
