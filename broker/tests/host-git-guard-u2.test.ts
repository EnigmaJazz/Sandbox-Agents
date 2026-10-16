/**
 * host-git-exec-hardening — unit 2 (O1/O2/O3/O5).
 *
 * Focused companion to host-git-hardening.test.ts. Every test is non-vacuous:
 * reverting the fix it pins makes it fail.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnArgv } from "../src/msb.ts";
import {
  GitGuardError,
  findUnsafeRemoteKey,
  hardenGitArgv,
  isExecutionBearingLocalKey,
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

function makeRepo(prefix: string): string {
  const dir = tempDir(prefix);
  mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "-q", "-b", "main"]);
  runGit(dir, ["config", "user.name", "probe"]);
  runGit(dir, ["config", "user.email", "probe@local"]);
  return dir;
}

function writeScript(path: string, lines: string[]): void {
  writeFileSync(path, `#!/bin/sh\n${lines.join("\n")}\n`);
  chmodSync(path, 0o755);
}

// ---------------------------------------------------------------------------
// O2 — caller-supplied neutralization overrides are refused (native R4-004)
// ---------------------------------------------------------------------------

describe("gitguard — caller-supplied -c/-C overrides (O2)", () => {
  test("refuses a caller `-c core.hooksPath=<dir>` on an execution-bearing subcommand", async () => {
    const dir = makeRepo("u2-o2-hooks-");
    writeFileSync(join(dir, "a.txt"), "x\n");
    const argv = ["git", "-c", "core.hooksPath=/tmp/evil", "add", "--", "a.txt"];
    await expect(spawnArgv(argv, { cwd: dir })).rejects.toThrow(GitGuardError);
    await expect(spawnArgv(argv, { cwd: dir })).rejects.toThrow(/core\.hookspath/i);
  });

  test("refuses a caller `-c core.fsmonitor=<cmd>` and `-c core.pager=<cmd>`", async () => {
    const dir = makeRepo("u2-o2-fsmon-");
    writeFileSync(join(dir, "a.txt"), "x\n");
    await expect(
      spawnArgv(["git", "-c", "core.fsmonitor=/tmp/evil", "add", "--", "a.txt"], { cwd: dir }),
    ).rejects.toThrow(GitGuardError);
    await expect(
      spawnArgv(["git", "-c", "core.pager=/tmp/evil", "add", "--", "a.txt"], { cwd: dir }),
    ).rejects.toThrow(GitGuardError);
  });

  test("refuses a caller `-c core.attributesFile=...` and `-c core.excludesFile=...`", async () => {
    const dir = makeRepo("u2-o2-attrs-");
    writeFileSync(join(dir, "a.txt"), "x\n");
    await expect(
      spawnArgv(["git", "-c", "core.attributesFile=/tmp/evil", "add", "--", "a.txt"], { cwd: dir }),
    ).rejects.toThrow(GitGuardError);
    await expect(
      spawnArgv(["git", "-c", "core.excludesFile=/tmp/evil", "add", "--", "a.txt"], { cwd: dir }),
    ).rejects.toThrow(GitGuardError);
  });

  test("refuses a caller `-C <path>` on an execution-bearing subcommand", async () => {
    const dir = makeRepo("u2-o2-chdir-");
    writeFileSync(join(dir, "a.txt"), "x\n");
    const argv = ["git", "-C", dir, "add", "--", "a.txt"];
    await expect(spawnArgv(argv, { cwd: dir })).rejects.toThrow(GitGuardError);
    await expect(spawnArgv(argv, { cwd: dir })).rejects.toThrow(/-C/);
  });

  test("keeps the broker's own `-c user.name`/`-c user.email` identity pairs working", () => {
    const dir = makeRepo("u2-o2-identity-");
    const hardened = hardenGitArgv(
      ["git", "-c", "user.name=opencode-sandbox", "-c", "user.email=sandbox@local", "commit", "-m", "m"],
      { cwd: dir },
    );
    expect(hardened).toContain("commit");
    expect(hardened).toContain("user.name=opencode-sandbox");
  });

  test("never misfires on `git commit -C <commit>` (a subcommand option, not a global override)", () => {
    const dir = makeRepo("u2-o2-commit-c-");
    const hardened = hardenGitArgv(["git", "commit", "-C", "HEAD", "-m", "m"], { cwd: dir });
    expect(hardened).toContain("commit");
    expect(hardened).toContain("HEAD");
  });
});

// ---------------------------------------------------------------------------
// O1 — the guard resolves the SAME effective environment the child spawns with
// ---------------------------------------------------------------------------

function refusedRepo(prefix: string): string {
  // A repo whose repository-local config carries an execution-bearing key
  // (`include.path`), so the guard refuses any execution-bearing subcommand.
  const dir = makeRepo(prefix);
  const extra = join(dir, "extra.config");
  writeFileSync(extra, "");
  runGit(dir, ["config", "include.path", extra]);
  return dir;
}

function withEnv(key: string, value: string | undefined, body: () => Promise<void>): Promise<void> {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return body().finally(() => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  });
}

describe("gitguard — guard/child environment invariant (O1)", () => {
  test("an INHERITED process.env.GIT_DIR pointing at a refused repo still refuses", async () => {
    const dirty = refusedRepo("u2-o1-gitdir-");
    const clean = makeRepo("u2-o1-gitdir-clean-");
    writeFileSync(join(clean, "a.txt"), "x\n");
    await withEnv("GIT_DIR", join(dirty, ".git"), async () => {
      await expect(spawnArgv(["git", "add", "-A", "--"], { cwd: clean })).rejects.toThrow(
        GitGuardError,
      );
    });
  });

  test("opts.env.GIT_DIR (the spawn merge) overrides an inherited GIT_DIR for the guard too", async () => {
    const dirty = refusedRepo("u2-o1-override-");
    const clean = makeRepo("u2-o1-override-clean-");
    writeFileSync(join(clean, "a.txt"), "x\n");
    await withEnv("GIT_DIR", join(clean, ".git"), async () => {
      await expect(
        spawnArgv(["git", "add", "-A", "--"], {
          cwd: clean,
          env: { GIT_DIR: join(dirty, ".git") },
        }),
      ).rejects.toThrow(GitGuardError);
    });
  });

  test("an INHERITED GIT_COMMON_DIR pointing at a refused repo still refuses", async () => {
    const dirty = refusedRepo("u2-o1-common-");
    const clean = makeRepo("u2-o1-common-clean-");
    writeFileSync(join(clean, "a.txt"), "x\n");
    await withEnv("GIT_COMMON_DIR", join(dirty, ".git"), async () => {
      await expect(spawnArgv(["git", "add", "-A", "--"], { cwd: clean })).rejects.toThrow(
        GitGuardError,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// O3 — value-aware remote-transport guard
// ---------------------------------------------------------------------------

function remoteRepo(prefix: string, url: string): string {
  const dir = makeRepo(prefix);
  runGit(dir, ["remote", "add", "origin", "https://github.com/example/repo.git"]);
  runGit(dir, ["config", "remote.origin.url", url]);
  return dir;
}

describe("gitguard — remote-transport allowlist (O3)", () => {
  test("findUnsafeRemoteKey accepts https and rejects ext::/!cmd (pure)", () => {
    expect(findUnsafeRemoteKey('[remote "origin"]\n\turl = https://github.com/a/b.git\n')).toBe(null);
    expect(findUnsafeRemoteKey('[remote "origin"]\n\turl = ext::sh -c evil\n')).toContain("ext::");
    expect(findUnsafeRemoteKey('[remote "origin"]\n\turl = !touch pwned\n')).toContain("!");
  });

  test("a positive control: an https:// remote is accepted (bounded, no refusal)", async () => {
    const dir = remoteRepo("u3-https-", "https://github.com/example/repo.git");
    // Must NOT be refused by the guard. Bounded so an unreachable network
    // resolves (status != 0) instead of hanging; a guard refusal would reject.
    const res = await spawnArgv(["git", "fetch", "--dry-run", "origin"], {
      cwd: dir,
      timeoutMs: 8_000,
    });
    expect(res.timedOut || res.status !== null).toBe(true);
  });

  test("a positive control: a file:// remote is accepted", async () => {
    const dir = remoteRepo("u3-file-", `file://${tempDir("u3-file-target-")}`);
    const res = await spawnArgv(["git", "fetch", "--dry-run", "origin"], { cwd: dir });
    expect(res.status).not.toBe(null);
  });

  test("accepts scp-style `user@host:path` (positive control)", () => {
    expect(findUnsafeRemoteKey('[remote "origin"]\n\turl = git@github.com:example/repo.git\n')).toBe(
      null,
    );
  });

  test("refuses the ext:: remote-helper form and names the transport", async () => {
    const dir = remoteRepo("u3-ext-", "ext::sh -c evil");
    const argv = ["git", "fetch", "origin"];
    await expect(spawnArgv(argv, { cwd: dir, timeoutMs: 6_000 })).rejects.toThrow(GitGuardError);
    await expect(spawnArgv(argv, { cwd: dir, timeoutMs: 6_000 })).rejects.toThrow(/ext::/);
  });

  test("refuses the `!cmd` shell form and never runs the command", async () => {
    const dir = remoteRepo("u3-bang-", "!touch pwned");
    const marker = join(dir, "pwned");
    const argv = ["git", "push", "origin", "main"];
    await expect(spawnArgv(argv, { cwd: dir, timeoutMs: 6_000 })).rejects.toThrow(GitGuardError);
    expect(existsSync(marker)).toBe(false);
  });

  test("refuses a non-allowlisted transport (ftp://)", async () => {
    const dir = remoteRepo("u3-ftp-", "ftp://evil.example/repo");
    await expect(
      spawnArgv(["git", "fetch", "origin"], { cwd: dir, timeoutMs: 6_000 }),
    ).rejects.toThrow(/ftp/);
  });

  test("refuses remote.<name>.receivepack", async () => {
    const dir = remoteRepo("u3-recv-", "https://github.com/example/repo.git");
    runGit(dir, ["config", "remote.origin.receivepack", "sh -c evil"]);
    await expect(
      spawnArgv(["git", "push", "origin", "main"], { cwd: dir, timeoutMs: 6_000 }),
    ).rejects.toThrow(/receivepack/);
  });

  test("refuses url.<base>.insteadOf rewrite", async () => {
    const dir = remoteRepo("u3-insteadof-", "https://github.com/example/repo.git");
    runGit(dir, ["config", "url.https://evil.example/.insteadOf", "https://github.com/"]);
    await expect(
      spawnArgv(["git", "fetch", "origin"], { cwd: dir, timeoutMs: 6_000 }),
    ).rejects.toThrow(/insteadof/i);
  });
});

// ---------------------------------------------------------------------------
// O5 — test gaps: every refused-key branch (R3-001) and pager neutralization
// (R3-002)
// ---------------------------------------------------------------------------

describe("gitguard — every refused-key branch (O5 / R3-001)", () => {
  const REFUSED: ReadonlyArray<readonly [string, string | null, string]> = [
    ["filter", "x", "clean"],
    ["filter", "x", "smudge"],
    ["filter", "x", "process"],
    ["filter", "x", "required"],
    ["diff", "d", "command"],
    ["diff", "d", "textconv"],
    ["diff", null, "external"],
    ["include", null, "path"],
    ["includeif", "gitdir:/x", "path"],
    ["core", null, "gitproxy"],
    ["core", null, "sshcommand"],
    ["core", null, "editor"],
    ["core", null, "askpass"],
    ["credential", null, "helper"],
    ["merge", "m", "driver"],
    ["gpg", null, "program"],
    ["submodule", "s", "command"],
    ["sequence", null, "editor"],
  ];
  const ALLOWED: ReadonlyArray<readonly [string, string | null, string]> = [
    ["core", null, "hookspath"],
    ["core", null, "fsmonitor"],
    ["core", null, "pager"],
    ["user", null, "name"],
    ["filter", null, "clean"],
    ["diff", null, "command"],
    ["includeif", null, "path"],
    ["gpg", "x", "program"],
    ["sequence", "x", "editor"],
    ["merge", null, "driver"],
  ];

  test("refuses every execution-bearing key branch", () => {
    for (const [section, subsection, key] of REFUSED) {
      expect([
        section,
        subsection,
        key,
        isExecutionBearingLocalKey(section, subsection, key),
      ]).toEqual([section, subsection, key, true]);
    }
  });

  test("does not refuse the neutralized or benign key branches", () => {
    for (const [section, subsection, key] of ALLOWED) {
      expect([
        section,
        subsection,
        key,
        isExecutionBearingLocalKey(section, subsection, key),
      ]).toEqual([section, subsection, key, false]);
    }
  });
});

describe("gitguard — pager neutralization is observable (O5 / R3-002)", () => {
  test("a repository-local core.pager resolves to `cat` through the hardened argv", async () => {
    // Why resolved config, not a marker: git never launches a pager on the
    // non-tty pipes spawnArgv uses, even under --paginate (verified on git
    // 2.47.3), so a filesystem-marker probe would be vacuous with no possible
    // positive control. Git's OWN config resolution is the observable effect
    // here, and it fails if the `-c core.pager=cat` splice is reverted.
    const dir = makeRepo("u5-pager-");
    runGit(dir, ["config", "core.pager", "/tmp/evil-pager"]);

    // Positive control: unhardened git sees the repository-local pager.
    expect(runGit(dir, ["config", "--get", "core.pager"]).stdout.trim()).toBe("/tmp/evil-pager");

    const hardened = await spawnArgv(["git", "config", "--get", "core.pager"], { cwd: dir });
    expect(hardened.status).toBe(0);
    expect(hardened.stdout.trim()).toBe("cat");
  });
});
