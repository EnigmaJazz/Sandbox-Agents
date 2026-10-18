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
  mkdirSync(project);
  const git = Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { PATH: process.env.PATH ?? "" } });
  expect(git.exitCode).toBe(0);
  const helperPath = join(root, "review-helper.js");
  const auditPath = join(root, "spawn-audit.jsonl");
  writeFileSync(helperPath, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(auditPath)}, JSON.stringify([process.execPath, process.argv[1], ...args]) + "\\n");
if (args[0] === "artifact") process.exit(0);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => process.stdout.write(JSON.stringify(args[0] === "finalize" ? { kind: "writing", artifact: { verdict: "approved" } } : { phase: args[0], input })));
`);
  const helperSha256 = createHash("sha256").update(readFileSync(helperPath)).digest("hex");
  const reviewRunRoot = join(root, "review-runs");
  const config = defaultConfig({
    stateDir: join(root, "state"), reviewRunRoot, reviewHelperPath: helperPath,
    reviewHelperSha256: helperSha256, reviewHelperInterpreter: process.execPath,
    ...(caps ? { reviewRunMaxBytes: caps.maxBytes, reviewRunMaxFileBytes: caps.maxFileBytes, reviewRunMaxPerSession: caps.maxPerSession } : {}),
    projects: [{ id: "approved", path: project }], readOnlyAgents: ["gentle-orchestrator"],
  });
  const server = new BrokerServer(config);
  const internals = server as unknown as {
    ctx: { store: { touch(id: string, patch: Record<string, unknown>): unknown } };
    dispatch(req: BrokerRequestEnvelope): Promise<unknown>;
  };
  internals.ctx.store.touch(SESSION_ID, { agent: "gentle-orchestrator", state: "HOST_READ_ONLY" });
  return { root, project, helperPath, auditPath, reviewRunRoot, config, internals, store: new ReviewRunStore({ root: reviewRunRoot, projectRoot: project }) };
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
      payload: { projectDir: env.project, phase: "finalize", runId: writer.record.runId, stdin: "{}" },
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
  expect(spawns).toContainEqual([process.execPath, env.helperPath, "artifact", summaryPath]);
  expect(env.config.reviewHelperPath).toBe(env.helperPath);
  expect(env.config.reviewHelperSha256).toBe(createHash("sha256").update(readFileSync(env.helperPath)).digest("hex"));
  expect(env.config.reviewHelperInterpreter).toBe(process.execPath);
});

test("reviewPipeline dispatch chains all phase outputs by exact artifact reference", async () => {
  const env = operationFixture();
  const writer = env.store.createRun(SESSION_ID);
  const phases = ["screen", "prepare", "merge", "finalize"] as const;
  let input = "seed";
  for (const [index, phase] of phases.entries()) {
    const result = await env.internals.dispatch({
      version: 1, id: `chain-${phase}`, operation: "reviewPipelineRun", sessionID: SESSION_ID,
      payload: { projectDir: env.project, phase, ...(phase === "screen" ? { reviewer: "review-risk" } : {}), runId: writer.record.runId,
        ...(index === 0 ? { stdin: input } : { inputRef: `phase-${phases[index - 1]}.json` }) },
    }) as { outcome: string; artifact: { name: string; bytes: number; sha256: string }; summary: unknown };
    const expected = phase === "finalize"
      ? JSON.stringify({ kind: "writing", artifact: { verdict: "approved" } })
      : JSON.stringify({ phase, input });
    const bytes = readFileSync(join(env.store.runDir(SESSION_ID, writer.record.runId), `phase-${phase}.json`));
    expect(bytes.toString("utf8")).toBe(expected);
    expect(result).toMatchObject({ outcome: "accepted", artifact: { name: `phase-${phase}.json`, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") } });
    expect(JSON.stringify(result)).not.toContain(expected);
    input = bytes.toString("utf8");
  }
});

test("reviewMaterialize dispatch rejects contextLines above one hundred", async () => {
  const env = operationFixture();
  await expect(env.internals.dispatch({
    version: 1, id: "context-lines-over-limit", operation: "reviewMaterialize", sessionID: SESSION_ID,
    payload: { projectDir: env.project, baseRef: "HEAD", contextLines: 101 },
  })).rejects.toThrow("contextLines must be an integer from 0 through 100");
});
