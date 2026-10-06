import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "../..");
const installer = resolve(repoRoot, "scripts/install-user-files");
const tempDirs: string[] = [];
const pluginFiles = [
  ...readdirSync(resolve(repoRoot, "opencode/plugins"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name),
  ...readdirSync(resolve(repoRoot, "opencode/plugins/lib"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `lib/${entry.name}`),
];

function snapshotTree(root: string): string[] {
  const entries: string[] = [];
  const visit = (path: string) => {
    const stat = lstatSync(path);
    const relative = path.slice(root.length) || ".";
    if (stat.isSymbolicLink()) {
      entries.push(`${relative}:link:${readlinkSync(path)}:${stat.mode & 0o777}`);
    } else if (stat.isDirectory()) {
      entries.push(`${relative}:directory:${stat.mode & 0o777}`);
      for (const child of readdirSync(path).sort()) visit(resolve(path, child));
    } else {
      entries.push(`${relative}:file:${stat.mode & 0o777}:${readFileSync(path).toString("base64")}`);
    }
  };
  visit(root);
  return entries.sort();
}

function fixture() {
  const home = mkdtempSync(resolve(tmpdir(), "install-user-files-verify-"));
  tempDirs.push(home);
  const install = (source: string, destination: string) => {
    mkdirSync(resolve(destination, ".."), { recursive: true });
    copyFileSync(resolve(repoRoot, source), destination);
    chmodSync(destination, 0o644);
  };
  const nonoSource = resolve(repoRoot, "nono/profile/opencode-secure.json");
  const nonoDest = resolve(home, ".config/nono/profiles/opencode-secure.json");
  mkdirSync(resolve(nonoDest, ".."), { recursive: true });
  symlinkSync(nonoSource, nonoDest);
  install("systemd-user/sandbox-broker.service", resolve(home, ".config/systemd/user/sandbox-broker.service"));
  install("systemd-user/broker.env", resolve(home, ".config/opencode-sandbox/broker.env"));
  for (const file of pluginFiles) {
    install(`opencode/plugins/${file}`, resolve(home, ".config/opencode/plugins", file));
  }
  const stateDir = resolve(home, ".state-that-must-not-be-created");
  const journal = (action: string, source: string, destination: string) => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      resolve(stateDir, "install-journal.tsv"),
      `2026-01-01T00:00:00+00:00\t${action}\t${source}\t${destination}\t\n`,
      { flag: "a" },
    );
  };
  const run = (mode: string | string[] = "--verify", extraEnv: Record<string, string> = {}) => spawnSync("bash", [installer, ...(Array.isArray(mode) ? mode : [mode])], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, BROKER_STATE_DIR: stateDir, ...extraEnv },
  });
  return { home, stateDir, nonoDest, journal, run };
}

function commandShim(home: string, command: string): string {
  const bin = resolve(home, "command-shims");
  mkdirSync(bin, { recursive: true });
  const path = resolve(bin, command);
  writeFileSync(path, "#!/bin/sh\\nexit 1\\n");
  chmodSync(path, 0o755);
  return bin;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("install-user-files --verify", () => {
  test("returns zero when every installed counterpart matches and the journal is available", () => {
    const { home, journal, run } = fixture();
    journal("file", "sandbox-broker.service", resolve(home, ".config/systemd/user/sandbox-broker.service"));
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("drift");
  });

  test("reports a skipped stale check and returns the documented distinct status when the journal is absent", () => {
    const { run } = fixture();
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("stale destination check skipped: install journal is absent");
    expect(result.stdout).not.toContain("verification passed");
  });

  test("fails closed when the journal exists but is unusable", () => {
    const { stateDir, run } = fixture();
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(resolve(stateDir, "install-journal.tsv"));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: install journal is unusable");
    expect(result.stdout).not.toContain("verification passed");
  });

  test("fails closed when the install journal is a symlink", () => {
    const { stateDir, run } = fixture();
    mkdirSync(stateDir, { recursive: true });
    const journal = resolve(stateDir, "install-journal.tsv");
    writeFileSync(resolve(stateDir, "journal-target.tsv"), "");
    symlinkSync(resolve(stateDir, "journal-target.tsv"), journal);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: install journal is unusable");
  });

  test("fails closed when backup counting fails during verification", () => {
    const { home, journal, run } = fixture();
    journal("file", "sandbox-broker.service", resolve(home, ".config/systemd/user/sandbox-broker.service"));
    const result = run("--verify", { PATH: `${commandShim(home, "find")}:${process.env.PATH}` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: cannot list installer backups");
    expect(result.stdout).not.toContain("verification passed");
  });

  test("names an absent installed file and returns non-zero", () => {
    const { home, run } = fixture();
    const target = resolve(home, ".config/systemd/user/sandbox-broker.service");
    rmSync(target);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`${target}: absent`);
  });

  test("names a content difference and returns non-zero", () => {
    const { home, run } = fixture();
    const target = resolve(home, ".config/opencode-sandbox/broker.env");
    writeFileSync(target, "drifted without secrets\n");
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`${target}: content differs`);
  });

  test("classifies a directory in a regular-file slot as a type mismatch", () => {
    const { home, run } = fixture();
    const target = resolve(home, ".config/systemd/user/sandbox-broker.service");
    rmSync(target);
    mkdirSync(target);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`${target}: type differs (expected regular file)`);
  });

  test("rejects a symlink in a regular-file slot even when bytes match", () => {
    const { home, run } = fixture();
    const target = resolve(home, ".config/opencode-sandbox/broker.env");
    const linkedCopy = resolve(home, "broker.env-link-target");
    copyFileSync(target, linkedCopy);
    rmSync(target);
    symlinkSync(linkedCopy, target);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`${target}: type differs (expected regular file)`);
  });

  test("reports nono profile regular-file drift instead of accepting it", () => {
    const { home, nonoDest, run } = fixture();
    rmSync(nonoDest);
    copyFileSync(resolve(repoRoot, "nono/profile/opencode-secure.json"), nonoDest);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`${nonoDest}: type differs (expected symlink)`);
  });

  test("reports a nono profile symlink with the wrong target", () => {
    const { home, nonoDest, run } = fixture();
    const wrongTarget = resolve(home, "wrong-profile.json");
    writeFileSync(wrongTarget, "{}\\n");
    rmSync(nonoDest);
    symlinkSync(wrongTarget, nonoDest);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`${nonoDest}: link target differs`);
  });

  test("reports a journaled destination no longer listed by the installer", () => {
    const { home, journal, run } = fixture();
    const target = resolve(home, ".config/opencode/plugins/retired-plugin.ts");
    writeFileSync(target, "stale plugin\\n");
    journal("file", "retired-plugin.ts", target);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`${target}: stale installed destination`);
  });

  test("does not report an unmanaged file in a destination directory", () => {
    const { home, journal, run } = fixture();
    journal("file", "sandbox-broker.service", resolve(home, ".config/systemd/user/sandbox-broker.service"));
    const target = resolve(home, ".config/opencode/plugins/unmanaged-plugin.ts");
    writeFileSync(target, "owned by another installer\\n");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(target);
  });

  test("does not report installer backup artifacts", () => {
    const { home, journal, run } = fixture();
    journal("file", "sandbox-broker.service", resolve(home, ".config/systemd/user/sandbox-broker.service"));
    const target = resolve(home, ".config/opencode/plugins/sandbox-tools.ts.bak-20260101000000");
    writeFileSync(target, "installer backup\\n");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(target);
  });

  test("does not report directories in destination directories", () => {
    const { home, journal, run } = fixture();
    journal("file", "sandbox-broker.service", resolve(home, ".config/systemd/user/sandbox-broker.service"));
    const target = resolve(home, ".config/opencode/plugins/unmanaged-directory");
    mkdirSync(target);
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(target);
  });

  test("reports a verified count and the manual config merge exclusion", () => {
    const { home, journal, run } = fixture();
    journal("file", "sandbox-broker.service", resolve(home, ".config/systemd/user/sandbox-broker.service"));
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("verification passed: 13 installed files verified");
    expect(result.stdout).toContain("config fragment excluded (manual merge; no installed counterpart)");
  });

  test("names a mode difference and returns non-zero", () => {
    const { home, run } = fixture();
    const target = resolve(home, ".config/systemd/user/sandbox-broker.service");
    chmodSync(target, 0o600);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`${target}: mode differs`);
  });

  test("does not mutate any deployed destination while reporting drift", () => {
    const { home, stateDir, run } = fixture();
    const target = resolve(home, ".config/opencode-sandbox/broker.env");
    writeFileSync(target, "drift marker\n");
    const backup = `${target}.bak-20260101000000`;
    writeFileSync(backup, "old version\n");
    const before = snapshotTree(home);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(snapshotTree(home)).toEqual(before);
    expect(() => lstatSync(stateDir)).toThrow();
  });

  test("verify reports the installer backup count in its pass line", () => {
    const { home, journal, run } = fixture();
    journal("file", "sandbox-broker.service", resolve(home, ".config/systemd/user/sandbox-broker.service"));
    const target = resolve(home, ".config/opencode/plugins/sandbox-tools.ts");
    for (const stamp of ["20260101000000", "20260102000000"]) {
      writeFileSync(`${target}.bak-${stamp}`, "backup\n");
    }
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("verification passed: 13 installed files verified; 2 installer backups");
  });

  test("backup enumeration uses escaped, end-anchored installer names", () => {
    const source = readFileSync(installer, "utf8");
    expect(source.match(/-regex "[^"]*\$"/g) ?? []).toHaveLength(2);
    expect(source).toContain('escaped_name="$(printf \'%s\' "$name" | sed');
  });

  test("backup counting and pruning ignore names that extend a managed backup prefix", () => {
    const { home, journal, run } = fixture();
    journal("file", "sandbox-broker.service", resolve(home, ".config/systemd/user/sandbox-broker.service"));
    const target = resolve(home, ".config/opencode/plugins/sandbox-tools.ts");
    writeFileSync(`${target}.bak-20260101000000`, "backup\n");
    writeFileSync(`${target}.bak-20260102000000-extra`, "unmanaged\n");
    expect(run().stdout).toContain("1 installer backups");
    expect(run("--prune-backups").status).toBe(0);
    expect(readFileSync(`${target}.bak-20260102000000-extra`, "utf8")).toBe("unmanaged\n");
  });

  test("--prune-backups keeps three newest backups per managed destination", () => {
    const { home, run } = fixture();
    const first = resolve(home, ".config/opencode/plugins/sandbox-tools.ts");
    const second = resolve(home, ".config/systemd/user/sandbox-broker.service");
    for (const [dest, stamps] of [[first, ["20260101000000", "20260102000000", "20260103000000", "20260104000000"]], [second, ["20260101000000", "20260102000000", "20260103000000", "20260104000000"]]] as const) {
      for (const stamp of stamps) writeFileSync(`${dest}.bak-${stamp}`, "backup\n");
    }
    const unmanaged = resolve(home, ".config/opencode/plugins/unmanaged.ts.bak-20260101000000");
    writeFileSync(unmanaged, "unmanaged\n");
    const result = run("--prune-backups");
    expect(result.status).toBe(0);
    for (const dest of [first, second]) {
      expect(readdirSync(resolve(dest, ".." )).filter((name) => name.startsWith(`${dest.split("/").at(-1)}.bak-`))).toHaveLength(3);
      expect(result.stdout).toContain(`${dest}.bak-20260101`);
    }
    expect(readFileSync(unmanaged, "utf8")).toBe("unmanaged\n");
  });

  test("retention never removes the backup just created by the installer", () => {
    const { home, run } = fixture();
    const target = resolve(home, ".config/opencode/plugins/sandbox-tools.ts");
    writeFileSync(target, "outdated plugin\n");
    for (const stamp of ["20200101000000", "20210101000000", "20220101000000", "20230101000000"]) {
      writeFileSync(`${target}.bak-${stamp}`, "old backup\n");
    }
    const result = run("--dry-run");
    expect(result.status).toBe(0);
    const backups = readdirSync(resolve(target, "..")).filter((name) => name.startsWith("sandbox-tools.ts.bak-"));
    expect(backups).toHaveLength(3);
    const created = backups.find((name) => !name.endsWith("20200101000000") && !name.endsWith("20210101000000") && !name.endsWith("20220101000000") && !name.endsWith("20230101000000"));
    expect(created).toBeDefined();
    expect(result.stdout).toContain(`backed up ${target} -> ${resolve(target, "..")}/${created}`);
  });

  test("fails closed when a managed backup directory cannot be listed", () => {
    const { home, run } = fixture();
    const result = run("--prune-backups", { PATH: `${commandShim(home, "find")}:${process.env.PATH}` });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("error: cannot list installer backups");
    expect(result.stdout).not.toContain("error: cannot list installer backups");
  });

  test("fails closed when an installer backup cannot be removed", () => {
    const { home, run } = fixture();
    const target = resolve(home, ".config/opencode/plugins/sandbox-tools.ts");
    for (const stamp of ["20200101000000", "20210101000000", "20220101000000", "20230101000000"]) {
      writeFileSync(`${target}.bak-${stamp}`, "old backup\n");
    }
    const result = run("--prune-backups", { PATH: `${commandShim(home, "rm")}:${process.env.PATH}` });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("error: cannot remove installer backup");
  });

  test("refuses verify combined with explicit backup pruning", () => {
    const { home, run } = fixture();
    const target = resolve(home, ".config/opencode/plugins/sandbox-tools.ts.bak-20260101000000");
    writeFileSync(target, "backup\n");
    const before = snapshotTree(home);
    const result = run(["--verify", "--prune-backups"]);
    expect(result.status).not.toBe(0);
    expect(snapshotTree(home)).toEqual(before);
  });
});
