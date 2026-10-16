import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { buildDiffOp, type OpContext } from "../src/service.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "user.email", "test@local"]);
  writeFileSync(join(dir, "tracked.txt"), "base\n");
  writeFileSync(join(dir, "deleted.txt"), "delete me\n");
  git(dir, ["add", "tracked.txt", "deleted.txt"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["update-ref", "refs/opencode-sandbox/baseline/diff-fidelity", "HEAD"]);
}

/** Byte-accurate cap for every fake spawn in this file (Tier 4 item 58). */
function capped(text: string | null, cap: number): { text: string; truncated: boolean } {
  const value = text ?? "";
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= cap) return { text: value, truncated: false };
  return {
    text: Buffer.from(value, "utf8").subarray(0, cap).toString("utf8"),
    truncated: true,
  };
}

function makeHarness() {
  const root = tempDir("sandbox-diff-fidelity-");
  const workerDir = join(root, "worker");
  const stateDir = join(root, "state");
  initRepo(workerDir);
  const record: SessionRecord = {
    sessionID: "diff-fidelity",
    state: "SANDBOX_ACTIVE",
    workerName: "worker-diff-fidelity",
    workerState: "ACTIVE",
    baselineRef: "refs/opencode-sandbox/baseline/diff-fidelity",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const adapter = {
    exec: async (
      _worker: string,
      argv: string[],
      opts?: { cwd?: string; env?: Record<string, string>; maxOutputBytes?: number },
    ) => {
      const result = spawnSync(argv[0]!, argv.slice(1), {
        cwd: opts?.cwd === "/work" ? workerDir : workerDir,
        encoding: "utf8",
        env: { ...process.env, ...(opts?.env ?? {}) },
      });
      const cap = opts?.maxOutputBytes ?? Number.POSITIVE_INFINITY;
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
    },
  };
  const ctx = {
    config: defaultConfig({
      stateDir,
      projects: [{ id: "repo", path: workerDir }],
    }),
    store: { get: () => record },
    adapter,
    git: {
      runnerMode: "real",
      spawn: async (argv: string[], opts?: { cwd?: string; maxOutputBytes?: number }) => {
        const result = spawnSync(argv[0]!, argv.slice(1), {
          cwd: opts?.cwd ?? workerDir,
          encoding: "utf8",
        });
        const cap = opts?.maxOutputBytes ?? Number.POSITIVE_INFINITY;
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
      },
    },
  } as unknown as OpContext;
  const request: BrokerRequestEnvelope = {
    version: 1,
    id: "diff-fidelity-request",
    operation: "diff",
    sessionID: record.sessionID,
  };
  const indexPath = join(workerDir, ".git", "index");
  return { workerDir, stateDir, indexPath, record, ctx, request };
}

async function getDiff(harness: ReturnType<typeof makeHarness>) {
  return (await buildDiffOp(harness.ctx)(harness.request)) as {
    stat: string;
    diff: string;
    changedPaths: string[];
    applyPreview: { preview: string };
  };
}

describe("active sandbox diff fidelity with real Git", () => {
  test("a tracked-file edit alone produces a non-empty diff", async () => {
    const h = makeHarness();
    writeFileSync(join(h.workerDir, "tracked.txt"), "edited\n");

    const result = await getDiff(h);

    expect(result.diff).toContain("-base");
    expect(result.diff).toContain("+edited");
  });

  test("an untracked file appears in diff, stat, changed paths, and apply preview", async () => {
    const h = makeHarness();
    writeFileSync(join(h.workerDir, "new-file.txt"), "new content\n");

    const result = await getDiff(h);

    expect(result.diff).toContain("new-file.txt");
    expect(result.stat).toContain("new-file.txt");
    expect(result.changedPaths).toContain("new-file.txt");
    expect(result.applyPreview.preview).toContain("new-file.txt");
  });

  test("a tracked edit and untracked file appear together in one diff", async () => {
    const h = makeHarness();
    writeFileSync(join(h.workerDir, "tracked.txt"), "edited\n");
    writeFileSync(join(h.workerDir, "new-file.txt"), "new content\n");

    const result = await getDiff(h);

    expect(result.diff).toContain("-base");
    expect(result.diff).toContain("+edited");
    expect(result.diff).toContain("new-file.txt");
    expect(result.changedPaths).toContain("tracked.txt");
    expect(result.changedPaths).toContain("new-file.txt");
  });

  test("an oversized diff is refused instead of returned partially", async () => {
    const h = makeHarness();
    writeFileSync(join(h.workerDir, "tracked.txt"), `${"x".repeat(600 * 1024)}\n`);

    await expect(getDiff(h)).rejects.toThrow("diff refused: diff output exceeds 524288 bytes");
  });

  test("an oversized retained diff is refused instead of returned partially", async () => {
    const h = makeHarness();
    writeFileSync(join(h.workerDir, "tracked.txt"), `${"x".repeat(600 * 1024)}\n`);
    git(h.workerDir, ["add", "tracked.txt"]);
    git(h.workerDir, ["commit", "-q", "-m", "large result"]);
    h.record.state = "RETAINED";
    h.record.projectID = "repo";
    h.record.resultRef = git(h.workerDir, ["rev-parse", "HEAD"]).stdout.trim();

    const request = { ...h.request, payload: { mode: "retained" } };
    await expect(buildDiffOp(h.ctx)(request)).rejects.toThrow(
      "diff refused: diff output exceeds 524288 bytes",
    );
  });

  test(".broker-tmp files are excluded from changed paths", async () => {
    const h = makeHarness();
    mkdirSync(join(h.workerDir, ".broker-tmp"), { recursive: true });
    writeFileSync(join(h.workerDir, ".broker-tmp", "scratch.txt"), "temporary\n");

    const result = await getDiff(h);

    expect(result.changedPaths).not.toContain(".broker-tmp/scratch.txt");
    expect(result.diff).not.toContain("scratch.txt");
    expect(result.stat).not.toContain("scratch.txt");
    expect(result.applyPreview.preview).not.toContain("scratch.txt");
  });

  test("a deleted tracked file appears as deleted", async () => {
    const h = makeHarness();
    rmSync(join(h.workerDir, "deleted.txt"));

    const result = await getDiff(h);

    expect(result.diff).toContain("deleted file mode");
    expect(result.diff).toContain("deleted.txt");
    expect(result.changedPaths).toContain("deleted.txt");
  });

  test("sandbox_diff leaves the worker's real index and HEAD unchanged", async () => {
    const h = makeHarness();
    writeFileSync(join(h.workerDir, "tracked.txt"), "edited\n");
    writeFileSync(join(h.workerDir, "new-file.txt"), "new content\n");
    const indexBefore = readFileSync(h.indexPath);
    const headBefore = git(h.workerDir, ["rev-parse", "HEAD"]).stdout.trim();

    await getDiff(h);

    expect(readFileSync(h.indexPath).equals(indexBefore)).toBe(true);
    expect(git(h.workerDir, ["rev-parse", "HEAD"]).stdout.trim()).toBe(headBefore);
  });
});
