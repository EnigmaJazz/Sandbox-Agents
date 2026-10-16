/**
 * host-git-hardening — repository-local git execution vectors.
 *
 * The confined OpenCode process can write `<project>/.git` read-write; the
 * unconfined broker runs host `git` against that repository. These tests pin the
 * hardening applied at the single choke point (`spawnArgv` / `gitguard.ts`).
 *
 * T1 probe (executed BEFORE the fix, on git 2.47.3) — reachability with NO
 * neutralization, through `spawnArgv`:
 *
 *   | marker                                     | executed (pre-fix) |
 *   |--------------------------------------------|--------------------|
 *   | `.git/hooks/pre-commit`                    | true               |
 *   | repo-local `filter.<n>.clean`              | true               |
 *   | repo-local `core.fsmonitor` (command form) | true               |
 *
 * The tests below keep a POSITIVE CONTROL (raw git) proving each marker is
 * reachable unneutralized, then assert the hardened path suppresses it — so
 * reverting the neutralization or the guard re-creates the marker and fails.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnArgv } from "../src/msb.ts";
import {
  GIT_NEUTRALIZE_FLAGS,
  GitGuardError,
  findExecutionBearingLocalKey,
  findGitSubcommand,
  gitSubcommand,
  hardenGitArgv,
  isExecutionBearingLocalKey,
  parseLocalConfigKeys,
} from "../src/gitguard.ts";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function runGit(
  cwd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Raw git with NO broker hardening — the positive control. */
function gitInit(cwd: string): void {
  runGit(cwd, ["init", "-q", "-b", "main"]);
  runGit(cwd, ["config", "user.name", "probe"]);
  runGit(cwd, ["config", "user.email", "probe@local"]);
}

function makeRepo(prefix: string): string {
  const dir = tempDir(prefix);
  mkdirSync(dir, { recursive: true });
  gitInit(dir);
  return dir;
}

function writeScript(path: string, lines: string[]): void {
  writeFileSync(path, `#!/bin/sh\n${lines.join("\n")}\n`);
  chmodSync(path, 0o755);
}

function hookRepo(prefix: string): { dir: string; marker: string } {
  const dir = makeRepo(prefix);
  const marker = join(dir, "hook-ran");
  writeScript(join(dir, ".git", "hooks", "pre-commit"), [`touch '${marker}'`]);
  writeFileSync(join(dir, "a.txt"), "x\n");
  return { dir, marker };
}

function filterRepo(prefix: string): { dir: string; marker: string } {
  const dir = makeRepo(prefix);
  const marker = join(dir, "clean-ran");
  const script = join(dir, "clean.sh");
  writeScript(script, [`touch '${marker}'`, "cat"]);
  runGit(dir, ["config", "filter.probe.clean", script]);
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=probe\n");
  writeFileSync(join(dir, "a.txt"), "x\n");
  return { dir, marker };
}

function fsmonitorRepo(prefix: string): { dir: string; marker: string } {
  const dir = makeRepo(prefix);
  writeFileSync(join(dir, "a.txt"), "x\n");
  runGit(dir, ["add", "a.txt"]);
  runGit(dir, ["commit", "-qm", "base"]);
  const marker = join(dir, "fsmon-ran");
  const cmd = join(dir, "fsmon.sh");
  writeScript(cmd, [`touch '${marker}'`, "echo 2"]);
  runGit(dir, ["config", "core.fsmonitor", cmd]);
  return { dir, marker };
}

// ---------------------------------------------------------------------------
// gitguard — pure argv analysis
// ---------------------------------------------------------------------------

describe("gitguard — subcommand lookup skips leading options", () => {
  test("finds the subcommand at index 1 for a plain vector", () => {
    expect(findGitSubcommand(["git", "add", "--", "a"])).toEqual({
      index: 1,
      subcommand: "add",
    });
  });

  test("skips `-c`/`-C` value pairs and `--opt=value` forms", () => {
    expect(gitSubcommand(["git", "-c", "user.name=x", "-c", "user.email=y", "commit"])).toBe(
      "commit",
    );
    expect(gitSubcommand(["git", "-C", "/repo", "diff", "--stat"])).toBe("diff");
    expect(gitSubcommand(["git", "--git-dir=/repo/.git", "rev-parse"])).toBe("rev-parse");
    expect(gitSubcommand(["git", "--no-pager", "log"])).toBe("log");
  });

  test("reports no subcommand for option-only vectors", () => {
    expect(gitSubcommand(["git", "--version"])).toBe(null);
    expect(findGitSubcommand(["git", "-c", "a=b"])).toEqual({ index: -1, subcommand: null });
  });
});

describe("gitguard — hardenGitArgv neutralization splice", () => {
  test("leaves non-git binaries untouched", () => {
    expect(hardenGitArgv(["gh", "issue", "create"])).toEqual(["gh", "issue", "create"]);
    expect(hardenGitArgv(["git-lfs", "install"])).toEqual(["git-lfs", "install"]);
  });

  test("splices the neutralization flags before a git subcommand", () => {
    expect(hardenGitArgv(["git", "log", "-1"])).toEqual([
      "git",
      ...GIT_NEUTRALIZE_FLAGS,
      "log",
      "-1",
    ]);
  });

  test("keys on basename, so an absolute git path is still hardened", () => {
    const hardened = hardenGitArgv(["/usr/bin/git", "rev-parse", "HEAD"]);
    expect(hardened[0]).toBe("/usr/bin/git");
    expect(hardened.slice(1, 1 + GIT_NEUTRALIZE_FLAGS.length)).toEqual(GIT_NEUTRALIZE_FLAGS);
  });

  test("returns a new vector and never mutates its input", () => {
    const input = ["git", "log"];
    const hardened = hardenGitArgv(input);
    expect(input).toEqual(["git", "log"]);
    expect(hardened).not.toBe(input);
  });
});

describe("gitguard — dangerous repository-local keys", () => {
  test("matches execution-bearing keys and not neutralized ones", () => {
    expect(isExecutionBearingLocalKey("filter", "x", "clean")).toBe(true);
    expect(isExecutionBearingLocalKey("filter", "x", "smudge")).toBe(true);
    expect(isExecutionBearingLocalKey("filter", "x", "process")).toBe(true);
    expect(isExecutionBearingLocalKey("diff", "d", "textconv")).toBe(true);
    expect(isExecutionBearingLocalKey("diff", null, "external")).toBe(true);
    expect(isExecutionBearingLocalKey("include", null, "path")).toBe(true);
    expect(isExecutionBearingLocalKey("includeif", "gitdir:/x", "path")).toBe(true);
    expect(isExecutionBearingLocalKey("core", null, "sshcommand")).toBe(true);
    expect(isExecutionBearingLocalKey("submodule", "vendor", "command")).toBe(true);
    // Neutralized by `-c`, so NOT refused:
    expect(isExecutionBearingLocalKey("core", null, "hookspath")).toBe(false);
    expect(isExecutionBearingLocalKey("core", null, "fsmonitor")).toBe(false);
    // Plain identity is not a command:
    expect(isExecutionBearingLocalKey("user", null, "name")).toBe(false);
  });

  test("parses sections, legacy dotted subsections, comments and quotes", () => {
    expect(findExecutionBearingLocalKey('[filter "x"]\n\tclean = evil\n')).toBe(
      'filter "x".clean',
    );
    expect(findExecutionBearingLocalKey("[filter.x]\nclean = evil\n")).toBe('filter "x".clean');
    expect(findExecutionBearingLocalKey('[filter "x"]\nclean = evil ; trailing\n')).toBe(
      'filter "x".clean',
    );
    expect(findExecutionBearingLocalKey('[includeIf "gitdir:/x"]\npath = /y\n')).toBe(
      'includeif "gitdir:/x".path',
    );
    expect(findExecutionBearingLocalKey("# comment\n[user]\n\tname = x\n")).toBe(null);
    expect(findExecutionBearingLocalKey("[core]\n\thooksPath = /tmp/hooks\n")).toBe(null);
  });

  test("parseLocalConfigKeys lowercases section and key names", () => {
    expect(parseLocalConfigKeys("[Core]\n\tSSHCommand = ls\n")).toEqual([
      { section: "core", subsection: null, key: "sshcommand" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// T1/T6 markers — reachable unneutralized, absent (or refused) when hardened
// ---------------------------------------------------------------------------

describe("gitguard — markers absent through the hardened spawn path", () => {
  test("pre-commit hook runs raw and is neutralized through spawnArgv", async () => {
    const raw = hookRepo("t6-hook-raw-");
    runGit(raw.dir, ["add", "--", "a.txt"]);
    runGit(raw.dir, ["commit", "-m", "raw"]);
    expect(existsSync(raw.marker)).toBe(true); // positive control

    const hardened = hookRepo("t6-hook-hard-");
    await spawnArgv(["git", "add", "--", "a.txt"], { cwd: hardened.dir });
    await spawnArgv(["git", "commit", "-m", "hardened"], { cwd: hardened.dir });
    expect(existsSync(hardened.marker)).toBe(false);
  });

  test("clean filter runs raw and is refused through spawnArgv", async () => {
    const raw = filterRepo("t6-filter-raw-");
    runGit(raw.dir, ["add", "--", "a.txt"]);
    expect(existsSync(raw.marker)).toBe(true); // positive control

    const hardened = filterRepo("t6-filter-hard-");
    await expect(
      spawnArgv(["git", "add", "--", "a.txt"], { cwd: hardened.dir }),
    ).rejects.toThrow(GitGuardError);
    expect(existsSync(hardened.marker)).toBe(false);
  });

  test("fsmonitor command runs raw and is neutralized through spawnArgv", async () => {
    const raw = fsmonitorRepo("t6-fsmon-raw-");
    runGit(raw.dir, ["status", "--porcelain"]);
    expect(existsSync(raw.marker)).toBe(true); // positive control

    const hardened = fsmonitorRepo("t6-fsmon-hard-");
    const res = await spawnArgv(["git", "status", "--porcelain"], { cwd: hardened.dir });
    expect(res.status).toBe(0);
    expect(existsSync(hardened.marker)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T3/T6 — fail-closed refusals
// ---------------------------------------------------------------------------

describe("gitguard — fail-closed refusals", () => {
  test("a repository-local clean filter produces a named refusal before spawning", async () => {
    const { dir, marker } = filterRepo("t6-refuse-");
    await expect(spawnArgv(["git", "add", "--", "a.txt"], { cwd: dir })).rejects.toThrow(
      /filter "probe"\.clean/,
    );
    expect(existsSync(marker)).toBe(false);
  });

  test("a repository-local diff driver command is refused", async () => {
    const dir = makeRepo("t6-diffdriver-");
    runGit(dir, ["config", "diff.mine.command", "true; touch pwned"]);
    await expect(spawnArgv(["git", "diff", "--stat"], { cwd: dir })).rejects.toThrow(
      GitGuardError,
    );
  });

  test("a repository-local include.path is refused", async () => {
    const dir = makeRepo("t6-include-");
    const extra = join(dir, "extra.config");
    writeFileSync(extra, "");
    runGit(dir, ["config", "include.path", extra]);
    await expect(spawnArgv(["git", "add", "-A", "--"], { cwd: dir })).rejects.toThrow(
      GitGuardError,
    );
  });

  test("an execution-bearing subcommand with no resolvable git dir fails closed", async () => {
    const empty = tempDir("t6-empty-");
    await expect(spawnArgv(["git", "add", "-A", "--"], { cwd: empty })).rejects.toThrow(
      /could not be resolved/,
    );
  });

  test("GIT_DIR in opts.env is honoured when resolving the git dir", async () => {
    const { dir } = filterRepo("t6-gitdir-");
    const elsewhere = tempDir("t6-elsewhere-");
    await expect(
      spawnArgv(["git", "add", "-A", "--"], {
        cwd: elsewhere,
        env: { GIT_DIR: join(dir, ".git") },
      }),
    ).rejects.toThrow(GitGuardError);
  });

  test("a linked worktree resolves through the `.git` file and commondir", async () => {
    const root = tempDir("t6-worktree-");
    const main = join(root, "main");
    mkdirSync(main);
    gitInit(main);
    writeFileSync(join(main, "a.txt"), "x\n");
    runGit(main, ["add", "a.txt"]);
    runGit(main, ["commit", "-qm", "base"]);
    const extra = join(root, "extra.config");
    writeFileSync(extra, "");
    runGit(main, ["config", "include.path", extra]);
    const wt = join(root, "wt");
    expect(runGit(main, ["worktree", "add", "-q", "-b", "wt", wt]).status).toBe(0);
    expect(existsSync(join(wt, ".git"))).toBe(true);
    await expect(spawnArgv(["git", "add", "-A", "--"], { cwd: wt })).rejects.toThrow(
      GitGuardError,
    );
  });

  test("read-only plumbing is not refused by an execution-bearing local key", async () => {
    const { dir } = filterRepo("t6-readonly-");
    const config = await spawnArgv(["git", "config", "--get", "filter.probe.clean"], {
      cwd: dir,
    });
    expect(config.status).toBe(0);
    const inside = await spawnArgv(["git", "rev-parse", "--is-inside-work-tree"], { cwd: dir });
    expect(inside.stdout.trim()).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// T6 — the scoped posture does not over-neutralize the trusted global config
// ---------------------------------------------------------------------------

describe("gitguard — trusted global config stays in force", () => {
  test("a globally configured value is still read through spawnArgv", async () => {
    const dir = tempDir("t6-global-");
    runGit(dir, ["init", "-q", "-b", "main"]); // no local user.name
    const globalConfig = join(dir, "global.config");
    writeFileSync(globalConfig, "[user]\n\tname = Global Probe\n");
    const res = await spawnArgv(["git", "config", "--get", "user.name"], {
      cwd: dir,
      env: { GIT_CONFIG_GLOBAL: globalConfig },
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("Global Probe");
  });
});
