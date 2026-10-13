import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { buildSandboxResultInstallOp, type OpContext } from "../src/service.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const ORCHESTRATOR = "gentle-orchestrator";
const BASELINE_REF = "refs/opencode-sandbox/baseline/worker-delete-containment";
const RESULT_REF = "refs/opencode-sandbox/result/worker-delete-containment";

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function record(sessionID: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionID,
    state: sessionID === "session-1" ? "HOST_READ_ONLY" : "RESULT_READY",
    projectID: "test",
    baselineRef: `${BASELINE_REF}`,
    resultRef: `${RESULT_REF}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(sessionID === "session-1" ? { agent: ORCHESTRATOR } : {}),
    ...overrides,
  };
}

describe("sandbox result deletion containment", () => {
  test("refuses an escaped parent symlink by name without deleting the outside file", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "result-delete-containment-"));
    const repo = join(tempRoot, "repo");
    const nested = join(repo, "nested");
    const outside = join(tempRoot, "outside");
    const outsideFile = join(outside, "gone.ts");
    try {
      mkdirSync(nested, { recursive: true });
      mkdirSync(outside, { recursive: true });
      git(repo, ["init", "-q", "-b", "main"]);
      git(repo, ["config", "user.name", "Containment Test"]);
      git(repo, ["config", "user.email", "containment@example.invalid"]);
      git(repo, ["config", "commit.gpgsign", "false"]);
      writeFileSync(join(nested, "gone.ts"), "tracked\n");
      git(repo, ["add", "--", "nested/gone.ts"]);
      git(repo, ["commit", "-q", "-m", "baseline"]);
      git(repo, ["update-ref", BASELINE_REF, "HEAD"]);
      git(repo, ["checkout", "-q", "-b", "result"]);
      rmSync(join(nested, "gone.ts"));
      git(repo, ["add", "-u", "--", "nested/gone.ts"]);
      git(repo, ["commit", "-q", "-m", "deleted path"]);
      const resultCommit = git(repo, ["rev-parse", "HEAD"]);
      git(repo, ["update-ref", RESULT_REF, resultCommit]);
      git(repo, ["checkout", "-q", "main"]);

      rmSync(nested, { recursive: true });
      writeFileSync(outsideFile, "must survive\n");
      symlinkSync(outside, nested, "dir");
      const calls: string[][] = [];
      const spawn: OpContext["git"]["spawn"] = async (argv, opts) => {
        calls.push(argv);
        const result = spawnSync(argv[0]!, argv.slice(1), {
          cwd: opts.cwd ?? repo,
          env: opts.env ? { ...process.env, ...opts.env } : process.env,
          encoding: "utf8",
        });
        return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut: false };
      };
      const context = {
        config: defaultConfig({ readOnlyAgents: [ORCHESTRATOR], projects: [{ id: "test", path: repo }] }),
        store: { get: (sessionID: string) => sessionID === "session-1" ? record(sessionID) : record(sessionID) },
        adapter: {}, budget: {}, resources: {}, pool: { allocations: [] }, hostRead: { has: () => false },
        logger: {}, git: { runnerMode: "real", spawn },
      } as unknown as OpContext;
      const request: BrokerRequestEnvelope = {
        version: 1, id: "delete-containment", operation: "sandboxResultInstall", sessionID: "session-1",
        agent: ORCHESTRATOR,
        payload: { projectDir: repo, sandboxSessionID: "worker-delete-containment", expectedResultCommit: resultCommit },
      };
      const error = await buildSandboxResultInstallOp(context)(request).then(() => null, (value: unknown) => value);
      expect(String(error)).toContain("result-delete-parent-escape");
      expect(existsSync(outsideFile)).toBe(true);
      expect(calls.some((argv) => argv[0] === "rm")).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
