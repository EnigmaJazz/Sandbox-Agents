import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { readReviewSlice } from "../src/review-materialize.ts";
import { ReviewRunStore } from "../src/review-run.ts";
import { BrokerServer } from "../src/server.ts";
import type { BrokerRequestEnvelope } from "../src/types.ts";

const ORCHESTRATOR = "gentle-orchestrator";
const roots: string[] = [];
function temporary(): string {
  const base = ["/var/tmp", process.env.HOME ?? ""].find((candidate) => {
    try {
      const real = realpathSync(candidate);
      return real !== realpathSync(tmpdir()) && !real.startsWith(`${realpathSync(tmpdir())}/`);
    } catch { return false; }
  });
  if (!base) throw new Error("no writable test base outside $TMPDIR");
  const root = mkdtempSync(join(base, "review-materialize-operation-"));
  roots.push(root);
  return root;
}
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(overrides: Record<string, unknown> = {}) {
  const root = temporary();
  const project = join(root, "project");
  mkdirSync(project);
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: project, env: { PATH: process.env.PATH ?? "" } });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git(["init", "-q"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(project, "change.txt"), "base\n");
  git(["add", "change.txt"]);
  git(["commit", "-qm", "base"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(join(project, "change.txt"), "head\n");
  git(["add", "change.txt"]);
  git(["commit", "-qm", "head"]);
  const head = git(["rev-parse", "HEAD"]);
  const config = defaultConfig({
    stateDir: join(root, "state"),
    reviewRunRoot: join(root, "review-runs"),
    projects: [{ id: "approved", path: project }],
    readOnlyAgents: [ORCHESTRATOR],
    ...overrides,
  });
  const server = new BrokerServer(config);
  const internals = server as unknown as {
    ctx: { store: { touch(id: string, patch: Record<string, unknown>): unknown }; git: { spawn: (...args: any[]) => Promise<any> }; pool: { allocations: unknown[] } };
    dispatch(req: BrokerRequestEnvelope): Promise<unknown>;
  };
  const store = internals.ctx.store;
  store.touch("bound-orchestrator", { agent: ORCHESTRATOR, state: "HOST_READ_ONLY" });
  const request = (operation: string, sessionID: string, payload: unknown): BrokerRequestEnvelope => ({
    version: 1, id: `test-${operation}`, operation: operation as BrokerRequestEnvelope["operation"], sessionID, payload,
  });
  return { root, project, base, head, server, internals, store, request };
}

function gitInProject(project: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: project, env: { PATH: process.env.PATH ?? "" } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fakeGit(project: string, responses: (args: string[]) => { status: number; stdout: string; stderr: string }) {
  const cwds: string[] = [];
  const spawn = async (argv: string[], options: { cwd?: string }) => {
    cwds.push(options.cwd ?? "");
    return responses(argv.slice(1));
  };
  return { spawn, cwds };
}

describe("reviewMaterialize dispatch", () => {
  test("dispatches reviewDiffRead through the real store path and preserves arbitrary bytes", async () => {
    const env = fixture();
    const runStore = new ReviewRunStore({ root: join(env.root, "review-runs"), projectRoot: env.project });
    const bytes = Buffer.from([0x64, 0x69, 0x66, 0x66, 0xff, 0x00, 0xfe]);
    const writer = runStore.createRun("bound-orchestrator", { baseObjectId: env.base, headObjectId: env.head });
    const artifact = writer.addArtifact("scope.diff", bytes);
    writer.publish();

    const result = await env.internals.dispatch(env.request("reviewDiffRead", "bound-orchestrator", {
      projectDir: env.project, runId: writer.record.runId,
    })) as { data: number[]; bytes: number; sha256: string };
    expect(result.data).toEqual([...bytes]);
    expect(result.bytes).toBe(artifact.bytes);
    expect(result.sha256).toBe(artifact.sha256);
  });

  test("validates required and typed payload fields through the handler", async () => {
    const env = fixture();
    const fake = fakeGit(env.project, () => { throw new Error("Git should not run"); });
    env.internals.ctx.git.spawn = fake.spawn;
    await expect(env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", { projectDir: env.project })))
      .rejects.toMatchObject({ code: "validation" });
    await expect(env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", { projectDir: env.project, baseRef: env.base, headRef: 7 })))
      .rejects.toMatchObject({ code: "validation" });
    await expect(env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", { projectDir: env.project, baseRef: env.base, contextLines: -1 })))
      .rejects.toMatchObject({ code: "validation" });
    await expect(env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", { projectDir: env.project, baseRef: env.base, paths: "change.txt" })))
      .rejects.toMatchObject({ code: "validation" });
    await expect(env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", { projectDir: env.project, baseRef: env.base, paths: [7] })))
      .rejects.toMatchObject({ code: "validation" });
    await expect(env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", { projectDir: env.project, baseRef: env.base, runId: "caller-chosen" })))
      .rejects.toMatchObject({ code: "validation" });
    await expect(env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", { projectDir: env.project, baseRef: env.base, mode: "workspace" })))
      .rejects.toMatchObject({ code: "validation" });
    expect(fake.cwds).toEqual([]);
  });

  test("rejects path members containing NUL before diff execution", async () => {
    const env = fixture();
    await expect(env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", {
      projectDir: env.project, baseRef: env.base, paths: ["bad\0path"],
    }))).rejects.toMatchObject({ code: "review_range_paths_invalid" });
  });

  test("resolves the exact approved project root and refuses other directories", async () => {
    const env = fixture();
    await env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", { projectDir: env.project, baseRef: env.base }));

    const nested = join(env.project, "nested");
    mkdirSync(nested);
    await expect(env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", { projectDir: nested, baseRef: env.base })))
      .rejects.toMatchObject({ code: "validation", message: expect.stringContaining("exact approved project root") });
    const outside = join(env.root, "outside");
    mkdirSync(outside);
    await expect(env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", { projectDir: outside, baseRef: env.base })))
      .rejects.toMatchObject({ code: "validation", message: expect.stringContaining("not an approved project root") });
  });

  test("preserves exact materialization refusal codes through dispatch", async () => {
    const env = fixture();
    await expect(env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", { projectDir: env.project, baseRef: "not-a-ref" })))
      .rejects.toMatchObject({ code: "review_range_ref_unresolvable" });

    writeFileSync(join(env.project, "oversized.txt"), "line\n".repeat(1501));
    gitInProject(env.project, ["add", "oversized.txt"]);
    gitInProject(env.project, ["commit", "-qm", "oversized"]);
    const oversizedHead = gitInProject(env.project, ["rev-parse", "HEAD"]);
    await expect(env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", {
      projectDir: env.project, baseRef: env.base, headRef: oversizedHead,
    }))).rejects.toMatchObject({ code: "review_range_file_slice_cap" });

    const capped = fixture({ reviewRunMaxBytes: 100 });
    await expect(capped.internals.dispatch(capped.request("reviewMaterialize", "bound-orchestrator", { projectDir: capped.project, baseRef: capped.base })))
      .rejects.toMatchObject({ code: "review_range_byte_cap" });

    const runStore = new ReviewRunStore({ root: join(env.root, "reader-store"), projectRoot: env.project });
    await expect(readReviewSlice("a".repeat(32), "slice-0000.diff", "bound-orchestrator", { store: runStore }))
      .rejects.toMatchObject({ code: "review_slice_not_found" });
  });

  test("uses production Git spawn through dispatch and publishes the exact range", async () => {
    const env = fixture();
    const runRoot = join(env.root, "review-runs");
    const index = await env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", {
      projectDir: env.project, baseRef: env.base, headRef: env.head,
    })) as { runId: string; changedPaths: string[]; sliceCount: number; totalBytes: number };

    expect(index.runId).toMatch(/^[0-9a-f]{32}$/);
    expect(index.changedPaths).toEqual(["change.txt"]);
    expect(index.sliceCount).toBeLessThanOrEqual(1);
    expect(JSON.stringify(index).length).toBeLessThan(8192);

    const runDir = join(runRoot, "bound-orchestrator", index.runId);
    expect(existsSync(join(runDir, "metadata.json"))).toBe(true);
    expect(existsSync(join(runDir, "scope.diff"))).toBe(true);
    expect(existsSync(join(runDir, "slice-0000.diff"))).toBe(true);
    const actual = readFileSync(join(runDir, "scope.diff"));
    const expected = Bun.spawnSync(["git", "diff", "--no-ext-diff", "--no-color", "--no-textconv", "-U3", env.base, env.head], {
      cwd: env.project, env: { PATH: process.env.PATH ?? "" },
    });
    expect(expected.exitCode).toBe(0);
    expect(actual.equals(expected.stdout)).toBe(true);
    expect(actual.byteLength).toBe(index.totalBytes);
  });

  test("uses a replacement environment against ambient GIT_DIR through production dispatch", async () => {
    const env = fixture();
    const decoy = join(env.root, "decoy");
    mkdirSync(decoy);
    const git = (cwd: string, args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd, env: { PATH: process.env.PATH ?? "" } });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    git(decoy, ["init", "-q"]);
    git(decoy, ["config", "user.name", "Test"]);
    git(decoy, ["config", "user.email", "test@example.invalid"]);
    writeFileSync(join(decoy, "change.txt"), "DECOY_SENTINEL\\n");
    git(decoy, ["add", "change.txt"]);
    git(decoy, ["commit", "-qm", "decoy"]);

    const expected = Bun.spawnSync(["git", "diff", "--no-ext-diff", "--no-color", "--no-textconv", "-U3", env.base, env.head], {
      cwd: env.project, env: { PATH: process.env.PATH ?? "" },
    });
    expect(expected.exitCode).toBe(0);
    const originalGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = join(decoy, ".git");
    try {
      const index = await env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", {
        projectDir: env.project, baseRef: env.base, headRef: env.head,
      })) as { runId: string; baseObjectId: string; headObjectId: string };
      const runDir = join(env.root, "review-runs", "bound-orchestrator", index.runId);
      const diff = readFileSync(join(runDir, "scope.diff"), "utf8");
      const record = JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8")) as { baseObjectId: string; headObjectId: string };
      expect(index.baseObjectId).toBe(env.base);
      expect(index.headObjectId).toBe(env.head);
      expect(record.baseObjectId).toBe(env.base);
      expect(record.headObjectId).toBe(env.head);
      expect(diff).toBe(expected.stdout.toString());
      expect(diff).not.toContain("DECOY_SENTINEL");
    } finally {
      if (originalGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = originalGitDir;
    }
  });

  test("allows the bound orchestrator through the exemption but denies workers and other identities", async () => {
    const env = fixture();
    const before = env.store.get("bound-orchestrator");
    const poolBefore = [...env.internals.ctx.pool.allocations];
    await expect(env.internals.dispatch(env.request("reviewMaterialize", "bound-orchestrator", { projectDir: env.project })))
      .rejects.toMatchObject({ code: "validation", message: expect.stringContaining("baseRef") });
    expect(env.store.get("bound-orchestrator")).toEqual(before);
    expect(env.internals.ctx.pool.allocations).toEqual(poolBefore);

    await expect(env.internals.dispatch(env.request("exec", "bound-orchestrator", {})))
      .rejects.toMatchObject({ code: "policy", message: expect.stringContaining("orchestrator-readonly") });
    expect(env.store.get("bound-orchestrator")).toEqual(before);
    expect(env.internals.ctx.pool.allocations).toEqual(poolBefore);

    env.store.touch("ordinary-agent", { agent: "general", state: "HOST_READ_ONLY" });
    await expect(env.internals.dispatch(env.request("reviewMaterialize", "ordinary-agent", { projectDir: env.project, baseRef: env.base })))
      .rejects.toMatchObject({ code: "policy", message: expect.stringContaining("orchestrator-only") });
    expect(env.store.get("ordinary-agent")?.workerName).toBeUndefined();
    expect(env.internals.ctx.pool.allocations).toEqual(poolBefore);
  });
});
