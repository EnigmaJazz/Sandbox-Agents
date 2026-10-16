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

/** Byte-accurate cap used by every fake spawn: a wrong implementation fails. */
function capped(text: string | null, cap: number): { text: string; truncated: boolean } {
  const value = text ?? "";
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= cap) return { text: value, truncated: false };
  return {
    text: Buffer.from(value, "utf8").subarray(0, cap).toString("utf8"),
    truncated: true,
  };
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
    // Model the byte cap and overflow flag the REAL spawn boundary emits, so
    // the over-cap assertions below observe the boundary rather than a string
    // `.slice` that never fires (Tier 4 item 58).
    const cap = options?.maxOutputBytes ?? Number.POSITIVE_INFINITY;
    const stdout = capped(result.stdout, cap);
    const stderr = capped(result.stderr, cap);
    return {
      status: result.status ?? 1,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut: false,
      outputTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
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
    rawPatchTruncated: boolean;
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
    expect(result.rawPatchTruncated).toBe(false);
  });

  test("patch bytes equal the UTF-8 byte length of the reported patch", async () => {
    const h = makeHarness([{ path: "new-file.txt", content: "new content\n" }]);

    const result = await getResult(h);

    expect(result.patchBytes).toBe(Buffer.byteLength(result.patch, "utf8"));
    expect(result.rawPatchTruncated).toBe(false);
  });

  test("a no-change result reports zero patch bytes", async () => {
    const h = makeHarness();

    const result = await getResult(h);

    expect(result.patchBytes).toBe(0);
    expect(result.rawPatchTruncated).toBe(false);
  });

  test("a patch over the git output cap omits its byte count and apply preview", async () => {
    const h = makeHarness([{ path: "large-file.txt", content: "a".repeat(512 * 1024 + 1) }]);

    const result = await getResult(h);

    expect(result.patchBytes).toBeUndefined();
    expect(result.rawPatchTruncated).toBe(true);
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
