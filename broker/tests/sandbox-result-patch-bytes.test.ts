import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { buildSandboxResultOp, type OpContext } from "../src/service.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const ORCHESTRATOR = "gentle-orchestrator";
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function makeHarness(resultChanges: { path: string; content: string }[] = []) {
  const root = tempDir("sandbox-result-patch-bytes-");
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "user.email", "test@local"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  git(repo, ["update-ref", "refs/opencode-sandbox/baseline/session-1", "HEAD"]);

  for (const change of resultChanges) {
    writeFileSync(join(repo, change.path), change.content);
  }
  if (resultChanges.length > 0) {
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "result"]);
  }
  git(repo, ["update-ref", "refs/opencode-sandbox/result/session-1", "HEAD"]);

  const record: SessionRecord = {
    sessionID: "session-1",
    projectID: "repo",
    state: "RESULT_READY",
    baselineRef: "refs/opencode-sandbox/baseline/session-1",
    resultRef: "refs/opencode-sandbox/result/session-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const config = defaultConfig({
    stateDir,
    readOnlyAgents: [ORCHESTRATOR],
    projects: [{ id: "repo", path: repo }],
  });
  const spawn: OpContext["git"]["spawn"] = async (argv, options) => {
    const result = spawnSync(argv[0]!, argv.slice(1), {
      cwd: options?.cwd ?? repo,
      encoding: "utf8",
      env: { ...process.env, ...(options?.env ?? {}) },
    });
    const maxOutputBytes = options?.maxOutputBytes ?? Number.POSITIVE_INFINITY;
    return {
      status: result.status ?? 1,
      stdout: (result.stdout ?? "").slice(0, maxOutputBytes),
      stderr: result.stderr ?? "",
      timedOut: false,
    };
  };
  const ctx = {
    config,
    store: { get: (sessionID: string) => sessionID === record.sessionID ? record : undefined },
    git: { runnerMode: "real", spawn },
  } as unknown as OpContext;
  const request: BrokerRequestEnvelope = {
    version: 1,
    id: "sandbox-result-patch-bytes",
    operation: "sandboxResult",
    sessionID: record.sessionID,
    agent: ORCHESTRATOR,
    payload: { projectDir: repo },
  };
  return { ctx, request };
}

async function getResult(harness: ReturnType<typeof makeHarness>) {
  return (await buildSandboxResultOp(harness.ctx)(harness.request)) as {
    changedPaths: { path: string; added: number | null; removed: number | null }[];
    patch: string;
    patchBytes?: number;
    patchBytesTruncated: boolean;
    authoredChangedLines: number;
    applyPreviewFiles?: unknown;
  };
}

describe("sandbox result patch byte receipt with real Git", () => {
  test("an untracked-only result reports nonzero patch bytes", async () => {
    const h = makeHarness([{ path: "new-file.txt", content: "new content\n" }]);

    const result = await getResult(h);

    expect(result.changedPaths.map(({ path }) => path)).toEqual(["new-file.txt"]);
    expect(result.patchBytes).toBeGreaterThan(0);
    expect(result.patchBytesTruncated).toBe(false);
  });

  test("patch bytes equal the UTF-8 byte length of the reported patch", async () => {
    const h = makeHarness([{ path: "new-file.txt", content: "new content\n" }]);

    const result = await getResult(h);

    expect(result.patchBytes).toBe(Buffer.byteLength(result.patch, "utf8"));
    expect(result.patchBytesTruncated).toBe(false);
  });

  test("a no-change result reports zero patch bytes", async () => {
    const h = makeHarness();

    const result = await getResult(h);

    expect(result.patchBytes).toBe(0);
    expect(result.patchBytesTruncated).toBe(false);
  });

  test("a patch over the git output cap omits its byte count and apply preview", async () => {
    const h = makeHarness([{ path: "large-file.txt", content: "a".repeat(512 * 1024 + 1) }]);

    const result = await getResult(h);

    expect(result.patchBytes).toBeUndefined();
    expect(result.patchBytesTruncated).toBe(true);
    expect(result.applyPreviewFiles).toBeUndefined();
  });

  test("authored changed lines equal the added and removed path counts", async () => {
    const h = makeHarness([{ path: "new-file.txt", content: "line one\nline two\n" }]);

    const result = await getResult(h);

    const expected = result.changedPaths.reduce(
      (total, change) => total + (change.added ?? 0) + (change.removed ?? 0),
      0,
    );
    expect(result.authoredChangedLines).toBe(expected);
  });
});
