/**
 * Apply-preview artifacts (R4-apply-preview-plain-diff).
 *
 * The broker writes two artifacts of the same B->C diff under
 * <stateDir>/apply-preview/, outside any worktree: a plain, escape-free
 * unified diff for editors, and an ANSI-coloured variant for terminals. The
 * plugin must stop writing its own colourised temp file and surface both
 * broker paths in the sandbox_apply ask metadata.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultConfig } from "../src/config.ts";
import { buildDiffOp, type OpContext } from "../src/service.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const SESSION_ID = "diff-session";
const ESC = String.fromCharCode(0x1b);

const SAMPLE_DIFF = [
  "diff --git a/openspec/spec.md b/openspec/spec.md",
  "index 1111111..2222222 100644",
  "--- a/openspec/spec.md",
  "+++ b/openspec/spec.md",
  "@@ -1,2 +1,3 @@",
  " unchanged context",
  "-removed line",
  "+added line",
  "+another added line",
  "",
].join("\n");

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "apply-preview-"));
}

function filesOf(result: unknown): { plain: string; ansi: string } {
  const files = (result as { applyPreviewFiles?: { plain: string; ansi: string } })
    .applyPreviewFiles;
  if (!files) throw new Error("applyPreviewFiles missing from diff response");
  return files;
}

function makeDiffContext(
  calls: string[][],
  opts: { stateDir: string; diff?: string },
): OpContext {
  const record: SessionRecord = {
    sessionID: SESSION_ID,
    state: "SANDBOX_ACTIVE",
    workerName: "worker-diff-session",
    workerState: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const diffStdout = opts.diff ?? "";

  return {
    config: defaultConfig({
      stateDir: opts.stateDir,
      projects: [{ id: "repo", path: "/repo" }],
    }),
    store: { get: () => record },
    adapter: {
      exec: async (_worker: string, argv: string[]) => {
        calls.push(argv);
        if (argv.includes("--stat")) {
          return { status: 0, stdout: "1 file changed", stderr: "", timedOut: false };
        }
        if (argv.includes("--name-only")) {
          return {
            status: 0,
            stdout: "openspec/spec.md\u0000",
            stderr: "",
            timedOut: false,
          };
        }
        return { status: 0, stdout: diffStdout, stderr: "", timedOut: false };
      },
    },
  } as unknown as OpContext;
}

const diffRequest: BrokerRequestEnvelope = {
  version: 1,
  id: "diff-request",
  operation: "diff",
  sessionID: SESSION_ID,
};

describe("apply-preview artifacts — plain and ANSI copies", () => {
  test("plain file is the complete diff with no escape sequences", async () => {
    const stateDir = makeStateDir();
    const result = await buildDiffOp(
      makeDiffContext([], { stateDir, diff: SAMPLE_DIFF }),
    )(diffRequest);
    const files = filesOf(result);

    const plain = readFileSync(files.plain, "utf8");
    expect(plain).toBe(SAMPLE_DIFF);
    expect(plain.includes(ESC)).toBe(false);
  });

  test("ANSI variant carries escapes and strips back to the plain content", async () => {
    const stateDir = makeStateDir();
    const result = await buildDiffOp(
      makeDiffContext([], { stateDir, diff: SAMPLE_DIFF }),
    )(diffRequest);
    const files = filesOf(result);

    const plain = readFileSync(files.plain, "utf8");
    const ansi = readFileSync(files.ansi, "utf8");
    expect(ansi.includes(ESC)).toBe(true);
    expect(stripAnsi(ansi)).toBe(plain);
    // Spot-check the colour rules ported from the plugin.
    expect(ansi).toContain(`${ESC}[1mdiff --git`);
    expect(ansi).toContain(`${ESC}[36m@@`);
    expect(ansi).toContain(`${ESC}[32m+added line`);
    expect(ansi).toContain(`${ESC}[31m-removed line`);
  });

  test("paths are stable for a session and match the state-dir layout", async () => {
    const stateDir = makeStateDir();
    const first = filesOf(
      await buildDiffOp(makeDiffContext([], { stateDir, diff: SAMPLE_DIFF }))(
        diffRequest,
      ),
    );
    const second = filesOf(
      await buildDiffOp(makeDiffContext([], { stateDir, diff: SAMPLE_DIFF }))(
        diffRequest,
      ),
    );

    expect(first).toEqual({
      plain: join(stateDir, "apply-preview", `${SESSION_ID}.diff`),
      ansi: join(stateDir, "apply-preview", `${SESSION_ID}.ansi.diff`),
    });
    expect(second).toEqual(first);
  });

  test("files are 0600 inside a 0700 directory", async () => {
    const stateDir = makeStateDir();
    const files = filesOf(
      await buildDiffOp(makeDiffContext([], { stateDir, diff: SAMPLE_DIFF }))(
        diffRequest,
      ),
    );

    expect(statSync(files.plain).mode & 0o777).toBe(0o600);
    expect(statSync(files.ansi).mode & 0o777).toBe(0o600);
    expect(statSync(join(stateDir, "apply-preview")).mode & 0o777).toBe(0o700);
  });

  test("artifacts live outside the worktree and never show in git status", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "apply-preview-repo-"));
    mkdirSync(repoDir, { recursive: true });
    const init = spawnSync("git", ["init", "-q", repoDir], { encoding: "utf8" });
    expect(init.status).toBe(0);

    const stateDir = makeStateDir();
    const files = filesOf(
      await buildDiffOp(makeDiffContext([], { stateDir, diff: SAMPLE_DIFF }))(
        diffRequest,
      ),
    );

    expect(files.plain.startsWith(repoDir)).toBe(false);
    expect(files.ansi.startsWith(repoDir)).toBe(false);
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(status.status).toBe(0);
    expect(status.stdout).not.toContain("apply-preview");
    expect(status.stdout.trim()).toBe("");
  });

  test("keeps the bounded prompt preview and truncation marker unchanged", async () => {
    const stateDir = makeStateDir();
    const bigDiff =
      Array.from({ length: 500 }, (_, i) => `+line ${i}`).join("\n") + "\n";
    const result = (await buildDiffOp(
      makeDiffContext([], { stateDir, diff: bigDiff }),
    )(diffRequest)) as {
      applyPreview?: { preview: string; previewTruncated: boolean; totalLines: number };
    };
    const files = filesOf(result);

    expect(result.applyPreview?.previewTruncated).toBe(true);
    expect(result.applyPreview?.totalLines).toBe(501);
    expect(result.applyPreview?.preview?.split("\n").length).toBe(401);
    expect(result.applyPreview?.preview).toContain(
      "see previewFile for the full diff",
    );
    // The full diff — not the bounded preview — is what lands on disk.
    expect(readFileSync(files.plain, "utf8")).toBe(bigDiff);
  });
});

describe("coloriseDiff — single implementation with the writer", () => {
  test("applies the documented ANSI rules and preserves context lines", async () => {
    const gitops = (await import("../src/gitops.ts")) as Record<string, unknown>;
    const colorise = gitops.coloriseDiff as ((diff: string) => string) | undefined;
    expect(typeof colorise).toBe("function");

    const coloured = colorise!(SAMPLE_DIFF);
    expect(coloured.includes(ESC)).toBe(true);
    expect(stripAnsi(coloured)).toBe(SAMPLE_DIFF);
    expect(coloured).toContain(`${ESC}[1m--- a/openspec/spec.md${ESC}[0m`);
    expect(coloured).toContain(`${ESC}[1m+++ b/openspec/spec.md${ESC}[0m`);
    expect(coloured).toContain(`${ESC}[36m@@ -1,2 +1,3 @@${ESC}[0m`);
    expect(coloured).toContain(`${ESC}[32m+added line${ESC}[0m`);
    expect(coloured).toContain(`${ESC}[31m-removed line${ESC}[0m`);
    expect(coloured).toContain("unchanged context");
  });
});

describe("sandbox_apply plugin metadata", () => {
  test("surfaces both broker paths and stops writing its own temp preview", () => {
    const plugin = readFileSync(
      resolve(import.meta.dir, "../../opencode/plugins/sandbox-tools.ts"),
      "utf8",
    );

    expect(plugin).toContain("applyPreviewFiles");
    // The approval boundary fails closed through the guard, which still carries
    // both broker artifact paths into the ask metadata.
    expect(plugin).toContain("requestApplyApproval");
    expect(plugin).toContain("previewFile: paths.previewFile");
    expect(plugin).toContain("previewAnsiFile: paths.previewAnsiFile");
    // One implementation only: the plugin no longer colours or writes a temp file.
    expect(plugin).not.toContain("coloriseDiff");
    expect(plugin).not.toContain("tmpdir()");
  });
});
