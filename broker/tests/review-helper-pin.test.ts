import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "../..");
const installer = resolve(repoRoot, "scripts/install-user-files");
const tempDirs: string[] = [];

function fixture(options: { source?: boolean; versions?: string[]; aliases?: string[] } = {}) {
  const home = mkdtempSync(resolve(tmpdir(), "review-helper-pin-"));
  tempDirs.push(home);
  const stateDir = resolve(home, ".local/state/opencode-sandbox");
  const sourceVersion = "3.21.0";
  const versions = options.versions ?? [sourceVersion];
  const sources = new Map<string, string>();
  for (const version of versions) {
    const path = resolve(home, `.cache/opencode/packages/@fro.bot/systematic@${version}/node_modules/@fro.bot/systematic/skills/ce-review/scripts/validate-review.mjs`);
    mkdirSync(resolve(path, ".."), { recursive: true });
    const bytes = Buffer.from(`#!/usr/bin/env node\n// source version ${version}\nconsole.log(${JSON.stringify(version)});\n`);
    writeFileSync(path, bytes);
    sources.set(version, path);
  }
  for (const alias of options.aliases ?? []) {
    const path = resolve(home, `.cache/opencode/packages/@fro.bot/${alias}/node_modules/@fro.bot/systematic/skills/ce-review/scripts/validate-review.mjs`);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, `// alias package ${alias}\n`);
  }
  if (options.source === false) {
    rmSync(resolve(home, ".cache/opencode"), { recursive: true, force: true });
  }
  mkdirSync(resolve(home, ".config/systemd/user"), { recursive: true });
  mkdirSync(resolve(home, ".config/opencode/plugins/lib"), { recursive: true });
  mkdirSync(resolve(home, ".config/nono/profiles"), { recursive: true });
  mkdirSync(resolve(home, ".config/opencode-sandbox"), { recursive: true });
  const testInstaller = resolve(home, "install-user-files");
  const source = readFileSync(installer, "utf8")
    .replace(
      'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      `SCRIPT_DIR="${resolve(repoRoot, "scripts")}"`,
    )
    .replace(
      'source "$SCRIPT_DIR/secure-launcher.conf"',
      'source "$SCRIPT_DIR/secure-launcher.conf"\nNONO_BIN="/bin/true"',
    );
  writeFileSync(testInstaller, source, { mode: 0o755 });
  const run = (...args: string[]) => spawnSync("bash", [testInstaller, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, BROKER_STATE_DIR: stateDir },
  });
  return { home, stateDir, sources, sourceVersion, run };
}

const destination = (stateDir: string) => resolve(stateDir, "review-helper/validate-review.mjs");
const config = (home: string) => resolve(home, ".config/opencode-sandbox/broker.env");

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("review helper installer pin", () => {
  test("dry run announces version and digest without creating pin state", () => {
    const { home, stateDir, sources, sourceVersion, run } = fixture();
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`selected ${sourceVersion}`);
    expect(result.stdout).toMatch(/sha256 [0-9a-f]{64}/);
    expect(readFileSync(sources.get(sourceVersion)!)).toBeInstanceOf(Buffer);
    expect(() => statSync(destination(stateDir))).toThrow();
    expect(() => statSync(config(home))).toThrow();
  });

  test("apply pins the highest version with private modes and broker env values", () => {
    const { home, stateDir, sources, run } = fixture({ versions: ["3.19.0", "3.21.0", "3.20.0"] });
    const result = run("--apply");
    expect(result.status, result.stderr).toBe(0);
    const dest = destination(stateDir);
    expect(readFileSync(dest)).toEqual(readFileSync(sources.get("3.21.0")!));
    expect(statSync(resolve(dest, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    const env = readFileSync(config(home), "utf8");
    expect(env).toContain(`BROKER_REVIEW_HELPER_PATH=${dest}`);
    expect(env).toMatch(/BROKER_REVIEW_HELPER_SHA256=[0-9a-f]{64}/);
    expect(result.stdout).toContain("3.19.0");
    expect(result.stdout).toContain("3.20.0");
  });

  test("verify succeeds after apply", () => {
    const { run } = fixture();
    expect(run("--apply").status).toBe(0);
    const result = run("--verify");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("review helper pin verified");
  });

  test("verify reports drift when pinned bytes change", () => {
    const { stateDir, run } = fixture();
    expect(run("--apply").status).toBe(0);
    writeFileSync(destination(stateDir), "altered helper\n");
    const result = run("--verify");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("DRIFT");
    expect(result.stdout).toContain("pinned sha256 differs from current package-cache source");
  });

  test("verify reports drift when the selected cache helper changes in place", () => {
    const { sources, run } = fixture();
    expect(run("--apply").status).toBe(0);
    writeFileSync(sources.get("3.21.0")!, "changed cache helper bytes\n");
    const result = run("--verify");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("pinned sha256 differs from current package-cache source");
  });

  test("verify requires deliberate repin when a newer cache version appears", () => {
    const { home, run } = fixture();
    expect(run("--apply").status).toBe(0);
    const newer = resolve(home, ".cache/opencode/packages/@fro.bot/systematic@3.22.0/node_modules/@fro.bot/systematic/skills/ce-review/scripts/validate-review.mjs");
    mkdirSync(resolve(newer, ".."), { recursive: true });
    writeFileSync(newer, "newer helper bytes\n");
    const result = run("--verify");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("version changed: recorded 3.21.0, cache has 3.22.0");
    expect(result.stdout).toContain("deliberate --apply required");
    expect(run("--apply").status).toBe(0);
    expect(run("--verify").status).toBe(0);
  });

  test("verify reports drift when broker env path does not name the pinned destination", () => {
    const { home, run } = fixture();
    expect(run("--apply").status).toBe(0);
    writeFileSync(config(home), readFileSync(config(home), "utf8").replace(/BROKER_REVIEW_HELPER_PATH=.*/, "BROKER_REVIEW_HELPER_PATH=/wrong/helper.mjs"));
    const result = run("--verify");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("live config helper path differs from pinned destination");
  });

  test("verify reports drift when broker env hash disagrees with pinned bytes", () => {
    const { home, run } = fixture();
    expect(run("--apply").status).toBe(0);
    writeFileSync(config(home), readFileSync(config(home), "utf8").replace(/BROKER_REVIEW_HELPER_SHA256=[0-9a-f]{64}/, `BROKER_REVIEW_HELPER_SHA256=${"0".repeat(64)}`));
    const result = run("--verify");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("DRIFT");
    expect(result.stdout).toContain("live config hash differs from pinned bytes");
  });

  test("missing helper source names the failure and pins nothing", () => {
    const { stateDir, run } = fixture({ source: false });
    const result = run("--apply");
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("REVIEW_HELPER_SOURCE_MISSING");
    expect(() => statSync(destination(stateDir))).toThrow();
  });

  test("selects the highest concrete version from the reported cache inventory", () => {
    const { stateDir, sources, run } = fixture({
      versions: ["3.18.4", "3.18.5", "3.18.6", "3.18.10", "3.20.0", "3.21.0", "3.21.5", "3.21.8", "3.22.4"],
      aliases: ["systematic", "latest"],
    });
    const result = run("--apply");
    expect(result.status).toBe(0);
    expect(readFileSync(destination(stateDir))).toEqual(readFileSync(sources.get("3.22.4")!));
    expect(result.stdout).toContain("selected 3.22.4");
  });

  test("compares semantic version components numerically", () => {
    const { stateDir, sources, run } = fixture({ versions: ["3.18.4", "3.18.10", "3.9.0", "3.10.0"] });
    const result = run("--apply");
    expect(result.status).toBe(0);
    expect(readFileSync(destination(stateDir))).toEqual(readFileSync(sources.get("3.18.10")!));
    expect(result.stdout).toContain("selected 3.18.10");
  });

  test("compares minor version components numerically", () => {
    const { stateDir, sources, run } = fixture({ versions: ["3.9.0", "3.10.0"] });
    const result = run("--apply");
    expect(result.status).toBe(0);
    expect(readFileSync(destination(stateDir))).toEqual(readFileSync(sources.get("3.10.0")!));
    expect(result.stdout).toContain("selected 3.10.0");
  });

  test("ignores systematic and latest aliases as non-version package entries", () => {
    const { stateDir, sources, run } = fixture({ versions: ["3.21.8"], aliases: ["systematic", "latest"] });
    const result = run("--apply");
    expect(result.status).toBe(0);
    expect(readFileSync(destination(stateDir))).toEqual(readFileSync(sources.get("3.21.8")!));
    expect(result.stdout).toContain("selected 3.21.8");
    expect(result.stdout).toContain("ignored non-version package source");
    expect(result.stdout).not.toContain("selected latest");
    expect(result.stdout).not.toContain("selected systematic");
  });

  test("chooses the configured highest-version source and never the decoy", () => {
    const { home, stateDir, sources, run } = fixture({ versions: ["3.20.0", "3.21.0"] });
    const decoy = resolve(home, ".cache/opencode/decoy/validate-review.mjs");
    mkdirSync(resolve(decoy, ".."), { recursive: true });
    writeFileSync(decoy, "not the selected source\n");
    const result = run("--apply");
    expect(result.status).toBe(0);
    expect(readFileSync(destination(stateDir))).toEqual(readFileSync(sources.get("3.21.0")!));
    expect(readFileSync(destination(stateDir))).not.toEqual(readFileSync(decoy));
    expect(result.stdout).toContain(sources.get("3.21.0")!);
    expect(result.stdout).toContain("selected 3.21.0");
  });
});
