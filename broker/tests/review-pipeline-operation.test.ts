import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { BrokerServer } from "../src/server.ts";
import { ReviewRunStore } from "../src/review-run.ts";
import type { BrokerRequestEnvelope } from "../src/types.ts";

const SESSION_ID = "bound-orchestrator";
const roots: string[] = [];
const rootBase = ["/var/tmp", process.env.HOME ?? ""].find((candidate) => {
  try { return candidate && !realpathSync(candidate).startsWith(`${realpathSync(tmpdir())}/`); }
  catch { return false; }
});
if (!rootBase) throw new Error("no writable test base outside $TMPDIR");

afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

test("reviewPersist dispatch passes the configured interpreter to artifact validation", async () => {
  const root = mkdtempSync(join(rootBase, "review-pipeline-operation-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const git = Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { PATH: process.env.PATH ?? "" } });
  expect(git.exitCode).toBe(0);

  const helperPath = join(root, "review-helper.js");
  writeFileSync(helperPath, "process.exit(0);\n");
  const helperSha256 = createHash("sha256").update(readFileSync(helperPath)).digest("hex");
  const reviewRunRoot = join(root, "review-runs");
  const config = defaultConfig({
    stateDir: join(root, "state"),
    reviewRunRoot,
    reviewHelperPath: helperPath,
    reviewHelperSha256: helperSha256,
    reviewHelperInterpreter: process.execPath,
    projects: [{ id: "approved", path: project }],
    readOnlyAgents: ["gentle-orchestrator"],
  });
  const server = new BrokerServer(config);
  const internals = server as unknown as {
    ctx: { store: { touch(id: string, patch: Record<string, unknown>): unknown } };
    dispatch(req: BrokerRequestEnvelope): Promise<unknown>;
  };
  internals.ctx.store.touch(SESSION_ID, { agent: "gentle-orchestrator", state: "HOST_READ_ONLY" });
  const store = new ReviewRunStore({ root: reviewRunRoot, projectRoot: project });
  const writer = store.createRun(SESSION_ID);
  const finalizeRef = "finalize-0000.json";
  writer.addArtifact(finalizeRef, JSON.stringify({ kind: "writing", artifact: { verdict: "approved" } }));

  const result = await internals.dispatch({
    version: 1,
    id: "test-review-persist",
    operation: "reviewPersist",
    sessionID: SESSION_ID,
    payload: { projectDir: project, runId: writer.record.runId, finalizeRef },
  }) as { outcome: string; validation: { status: string } };

  expect(result.validation.status).toBe("passed");
  expect(result.outcome).toBe("persisted");
});
