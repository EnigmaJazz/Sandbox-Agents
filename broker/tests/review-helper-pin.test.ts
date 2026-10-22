import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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
  const interpreterBin = resolve(home, "interpreter-bin");
  mkdirSync(interpreterBin);
  symlinkSync(process.execPath, resolve(interpreterBin, "node"));
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
  const anchorPath = resolve(home, "review-helper-anchor.txt");
  const anchorEntries = [...sources].map(([version, path]) => `${version} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
  writeFileSync(anchorPath, `${anchorEntries.join("\n")}\n`);
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
      'REVIEW_HELPER_ANCHOR="$REPO_ROOT/scripts/review-helper-anchor.txt"',
      `REVIEW_HELPER_ANCHOR="${anchorPath}"`,
    )
    .replace(
      'source "$SCRIPT_DIR/secure-launcher.conf"',
      'source "$SCRIPT_DIR/secure-launcher.conf"\nNONO_BIN="/bin/true"',
    );
  writeFileSync(testInstaller, source, { mode: 0o755 });
  const runEnv = (extraEnv: Record<string, string>, ...args: string[]) => spawnSync("bash", [testInstaller, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, BROKER_STATE_DIR: stateDir, PATH: `${interpreterBin}:${process.env.PATH ?? ""}`, ...extraEnv },
  });
  const run = (...args: string[]) => runEnv({}, ...args);
  return { home, stateDir, sources, sourceVersion, anchorPath, run, runEnv };
}

const destination = (stateDir: string) => resolve(stateDir, "review-helper/validate-review.mjs");
const config = (home: string) => resolve(home, ".config/opencode-sandbox/broker.env");

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("review helper installer pin", () => {
  test("dry run announces version and digest without creating pin state", () => {
    const { home, stateDir, sources, sourceVersion, run } = fixture();
    const result = run("--review-helper-version=3.21.0");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`selected ${sourceVersion}`);
    expect(result.stdout).toMatch(/sha256 [0-9a-f]{64}/);
    expect(readFileSync(sources.get(sourceVersion)!)).toBeInstanceOf(Buffer);
    expect(() => statSync(destination(stateDir))).toThrow();
    expect(() => statSync(config(home))).toThrow();
  });

  test.each(["--apply", "--verify"])("requires an explicit version for %s", (mode) => {
    const { stateDir, run } = fixture();
    const result = run(mode);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("REVIEW_HELPER_VERSION_REQUIRED");
    expect(result.stderr).toContain("--review-helper-version=<x.y.z>");
    expect(() => statSync(stateDir)).toThrow();
  });

  test("apply pins the explicitly named anchored lower version despite a higher cached version", () => {
    const { home, stateDir, sources, run } = fixture({ versions: ["3.19.0", "3.21.0", "3.20.0"] });
    const result = run("--review-helper-version=3.19.0", "--apply");
    expect(result.status, result.stderr).toBe(0);
    const dest = destination(stateDir);
    expect(readFileSync(dest)).toEqual(readFileSync(sources.get("3.19.0")!));
    expect(statSync(resolve(dest, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    const env = readFileSync(config(home), "utf8");
    expect(env).toContain(`BROKER_REVIEW_HELPER_PATH=${dest}`);
    expect(env).toMatch(/BROKER_REVIEW_HELPER_SHA256=[0-9a-f]{64}/);
    expect(env).toContain(`BROKER_REVIEW_HELPER_INTERPRETER=${process.execPath}`);
    expect(readFileSync(resolve(stateDir, "install-journal.tsv"), "utf8")).toContain(`interpreter=${process.execPath}`);
    expect(result.stdout).toContain(`selected 3.19.0 ${sources.get("3.19.0")!}`);
    expect(result.stdout).not.toContain(sources.get("3.21.0")!);
    const pin = JSON.parse(readFileSync(resolve(stateDir, "review-helper/pin.json"), "utf8"));
    expect(pin.version).toBe("3.19.0");
    expect(pin.sha256).toBe(createHash("sha256").update(readFileSync(dest)).digest("hex"));
  });

  test("apply refuses cache bytes that no longer match the anchor without creating pin state", () => {
    const { home, stateDir, sources, run } = fixture();
    writeFileSync(sources.get("3.21.0")!, "changed cache helper bytes\\n");
    const result = run("--review-helper-version=3.21.0", "--apply");
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("REVIEW_HELPER_ANCHOR_MISMATCH");
    expect(() => statSync(destination(stateDir))).toThrow();
    expect(() => statSync(resolve(stateDir, "review-helper/pin.json"))).toThrow();
    expect(() => statSync(config(home))).toThrow();
  });

  test("repeat apply keeps exactly one interpreter assignment", () => {
    const { home, run } = fixture();
    expect(run("--review-helper-version=3.21.0", "--apply").status).toBe(0);
    expect(run("--review-helper-version=3.21.0", "--apply").status).toBe(0);
    const env = readFileSync(config(home), "utf8");
    expect(env.match(/^BROKER_REVIEW_HELPER_INTERPRETER=/gm)).toHaveLength(1);
  });

  test("apply refuses when neither node nor bun resolves to an executable interpreter", () => {
    const { home, stateDir, runEnv } = fixture();
    const blockedBin = resolve(home, "blocked-bin");
    mkdirSync(blockedBin);
    for (const command of readdirSync("/usr/bin")) {
      if (command === "node" || command === "bun") continue;
      try { symlinkSync(resolve("/usr/bin", command), resolve(blockedBin, command)); } catch { /* duplicate alias */ }
    }
    const result = runEnv({ PATH: blockedBin }, "--review-helper-version=3.21.0", "--apply");
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("REVIEW_HELPER_INTERPRETER_MISSING");
    expect(() => statSync(destination(stateDir))).toThrow();
  });

  test("refuses a symlinked state ancestor without changing the external target", () => {
    const { home, stateDir, run } = fixture();
    const external = resolve(home, "external-state");
    mkdirSync(external);
    const target = resolve(external, "opencode-sandbox");
    mkdirSync(target);
    const marker = resolve(target, "marker");
    writeFileSync(marker, "external bytes\\n", { mode: 0o640 });
    const localStateParent = resolve(home, ".local/state");
    rmSync(localStateParent, { recursive: true, force: true });
    mkdirSync(resolve(home, ".local"));
    symlinkSync(external, localStateParent);
    const before = statSync(marker).mode & 0o777;
    const result = run("--review-helper-version=3.21.0", "--apply");
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("symlink destination path refused");
    expect(readFileSync(marker, "utf8")).toBe("external bytes\\n");
    expect(statSync(marker).mode & 0o777).toBe(before);
    expect(() => statSync(destination(stateDir))).toThrow();
  });

  test("rejects a dangling symlink at the helper destination directory", () => {
    const { stateDir, run } = fixture();
    mkdirSync(stateDir, { recursive: true });
    const helperDir = resolve(stateDir, "review-helper");
    symlinkSync(resolve(stateDir, "missing-target"), helperDir);
    const result = run("--review-helper-version=3.21.0", "--apply");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("symlink destination directory refused");
    expect(lstatSync(helperDir).isSymbolicLink()).toBe(true);
  });

  test("rejects a non-directory helper destination entry", () => {
    const { stateDir, run } = fixture();
    mkdirSync(stateDir, { recursive: true });
    const helperDir = resolve(stateDir, "review-helper");
    writeFileSync(helperDir, "not a directory\\n");
    const result = run("--review-helper-version=3.21.0", "--apply");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("destination is not a directory");
    expect(readFileSync(helperDir, "utf8")).toBe("not a directory\\n");
  });

  test("verify succeeds after apply", () => {
    const { run } = fixture();
    expect(run("--review-helper-version=3.21.0", "--apply").status).toBe(0);
    const result = run("--review-helper-version=3.21.0", "--verify");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("review helper pin parser runtime: bun");
    expect(result.stdout).toContain("review helper pin verified");
  });

  test("verify reports drift when pinned bytes change", () => {
    const { stateDir, run } = fixture();
    expect(run("--review-helper-version=3.21.0", "--apply").status).toBe(0);
    writeFileSync(destination(stateDir), "altered helper\n");
    const result = run("--review-helper-version=3.21.0", "--verify");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("DRIFT");
    expect(result.stdout).toContain("pinned sha256 differs from current package-cache source");
  });

  test("verify refuses cache helper bytes that no longer match the anchor", () => {
    const { sources, run } = fixture();
    const source = sources.get("3.21.0")!;
    expect(run("--review-helper-version=3.21.0", "--apply").status).toBe(0);
    const expected = createHash("sha256").update(readFileSync(source)).digest("hex");
    writeFileSync(source, "changed cache helper bytes\n");
    const observed = createHash("sha256").update(readFileSync(source)).digest("hex");
    const result = run("--review-helper-version=3.21.0", "--verify");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("REVIEW_HELPER_ANCHOR_MISMATCH");
    expect(result.stderr).toContain(expected);
    expect(result.stderr).toContain(observed);
  });

  test("verify ignores a higher unanchored version until the operator selects and anchors it", () => {
    const { home, anchorPath, run } = fixture();
    expect(run("--review-helper-version=3.21.0", "--apply").status).toBe(0);
    const newer = resolve(home, ".cache/opencode/packages/@fro.bot/systematic@3.22.0/node_modules/@fro.bot/systematic/skills/ce-review/scripts/validate-review.mjs");
    mkdirSync(resolve(newer, ".."), { recursive: true });
    writeFileSync(newer, "newer helper bytes\n");
    const stillPinned = run("--review-helper-version=3.21.0", "--verify");
    expect(stillPinned.status, stillPinned.stderr + stillPinned.stdout).toBe(0);
    expect(stillPinned.stdout).toContain("review helper pin verified");
    expect(stillPinned.stdout).not.toContain("3.22.0");

    const newerDigest = createHash("sha256").update(readFileSync(newer)).digest("hex");
    writeFileSync(anchorPath, `${readFileSync(anchorPath, "utf8")}3.22.0 ${newerDigest}\n`);
    const changedSelection = run("--review-helper-version=3.22.0", "--verify");
    expect(changedSelection.status).not.toBe(0);
    expect(changedSelection.stdout).toContain("version changed: recorded 3.21.0, cache has 3.22.0");
    expect(changedSelection.stdout).toContain("deliberate --apply required");
    expect(run("--review-helper-version=3.22.0", "--apply").status).toBe(0);
    expect(run("--review-helper-version=3.22.0", "--verify").status).toBe(0);
  });

  test("verify reports drift when broker env path does not name the pinned destination", () => {
    const { home, run } = fixture();
    expect(run("--review-helper-version=3.21.0", "--apply").status).toBe(0);
    writeFileSync(config(home), readFileSync(config(home), "utf8").replace(/BROKER_REVIEW_HELPER_PATH=.*/, "BROKER_REVIEW_HELPER_PATH=/wrong/helper.mjs"));
    const result = run("--review-helper-version=3.21.0", "--verify");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("live config helper path differs from pinned destination");
  });

  test("verify reports drift when broker env hash disagrees with pinned bytes", () => {
    const { home, run } = fixture();
    expect(run("--review-helper-version=3.21.0", "--apply").status).toBe(0);
    writeFileSync(config(home), readFileSync(config(home), "utf8").replace(/BROKER_REVIEW_HELPER_SHA256=[0-9a-f]{64}/, `BROKER_REVIEW_HELPER_SHA256=${"0".repeat(64)}`));
    const result = run("--review-helper-version=3.21.0", "--verify");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("DRIFT");
    expect(result.stdout).toContain("live config hash differs from pinned bytes");
  });

  test("missing helper source names the failure and pins nothing", () => {
    const { stateDir, run } = fixture({ source: false });
    const result = run("--review-helper-version=3.21.0", "--apply");
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("REVIEW_HELPER_SOURCE_MISSING");
    expect(() => statSync(destination(stateDir))).toThrow();
  });

  test("refused apply preserves the existing helper, pin record, and broker configuration", () => {
    const { home, stateDir, run } = fixture();
    expect(run("--review-helper-version=3.21.0", "--apply").status).toBe(0);
    const helper = destination(stateDir);
    const pin = resolve(stateDir, "review-helper/pin.json");
    const env = config(home);
    const before = [helper, pin, env].map((path) => {
      const stat = lstatSync(path);
      return { bytes: readFileSync(path), type: stat.isFile() ? "file" : "other", mode: stat.mode & 0o777 };
    });
    rmSync(resolve(home, ".cache/opencode"), { recursive: true, force: true });
    const result = run("--review-helper-version=3.21.0", "--apply");
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("REVIEW_HELPER_SOURCE_MISSING");
    expect([helper, pin, env].map((path) => {
      const stat = lstatSync(path);
      return { bytes: readFileSync(path), type: stat.isFile() ? "file" : "other", mode: stat.mode & 0o777 };
    })).toEqual(before);
  });

  test("verification accepts pretty-printed pin JSON with reordered keys", () => {
    const { stateDir, run } = fixture();
    expect(run("--review-helper-version=3.21.0", "--apply").status).toBe(0);
    const pin = resolve(stateDir, "review-helper/pin.json");
    const record = JSON.parse(readFileSync(pin, "utf8"));
    writeFileSync(pin, JSON.stringify({ sha256: record.sha256, source: record.source, version: record.version }, null, 2) + "\n");
    const result = run("--review-helper-version=3.21.0", "--verify");
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain("review helper pin verified");
  });

  test("verification names a malformed pin JSON record", () => {
    const { stateDir, run } = fixture();
    expect(run("--review-helper-version=3.21.0", "--apply").status).toBe(0);
    writeFileSync(resolve(stateDir, "review-helper/pin.json"), "{ malformed json }\n");
    const result = run("--review-helper-version=3.21.0", "--verify");
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("pin record malformed");
  });

  test("apply refuses unsupported and duplicate managed environment assignments before writing", () => {
    for (const value of ["/path with space/helper.mjs", '\"/quoted/helper.mjs\"', "/path\\\\with\\\\backslash/helper.mjs"]) {
      const { home, stateDir, run } = fixture();
      expect(run("--review-helper-version=3.21.0", "--apply").status).toBe(0);
      const env = config(home);
      const original = readFileSync(env);
      const helper = destination(stateDir);
      const pin = resolve(stateDir, "review-helper/pin.json");
      const before = [helper, pin].map((path) => ({ bytes: readFileSync(path), mode: statSync(path).mode & 0o777 }));
      writeFileSync(env, original.toString().replace(/BROKER_REVIEW_HELPER_PATH=.*/, `BROKER_REVIEW_HELPER_PATH=${value}`));
      const malformed = run("--review-helper-version=3.21.0", "--apply");
      expect(malformed.status).not.toBe(0);
      expect(malformed.stdout + malformed.stderr).toContain("malformed BROKER_REVIEW_HELPER_PATH assignment");
      expect([helper, pin].map((path) => ({ bytes: readFileSync(path), mode: statSync(path).mode & 0o777 }))).toEqual(before);
      writeFileSync(env, original);
      writeFileSync(env, `${original}BROKER_REVIEW_HELPER_PATH=${destination(stateDir)}\n`);
      const duplicate = run("--review-helper-version=3.21.0", "--apply");
      expect(duplicate.status).not.toBe(0);
      expect(duplicate.stdout + duplicate.stderr).toContain("duplicate BROKER_REVIEW_HELPER_PATH assignment");
    }
  });

  test("selects the explicitly named anchored version despite higher cache inventory entries", () => {
    const { stateDir, sources, run } = fixture({
      versions: ["3.18.4", "3.18.5", "3.18.6", "3.18.10", "3.20.0", "3.21.0", "3.21.5", "3.21.8", "3.22.4"],
      aliases: ["systematic", "latest"],
    });
    const result = run("--review-helper-version=3.18.4", "--apply");
    expect(result.status).toBe(0);
    expect(readFileSync(destination(stateDir))).toEqual(readFileSync(sources.get("3.18.4")!));
    expect(result.stdout).toContain(`selected 3.18.4 ${sources.get("3.18.4")!}`);
    expect(result.stdout).not.toContain(sources.get("3.22.4")!);
  });

  test("pins the explicitly requested patch version among nearby cached versions", () => {
    const { stateDir, sources, run } = fixture({ versions: ["3.18.4", "3.18.10", "3.9.0", "3.10.0"] });
    const result = run("--review-helper-version=3.18.10", "--apply");
    expect(result.status).toBe(0);
    expect(readFileSync(destination(stateDir))).toEqual(readFileSync(sources.get("3.18.10")!));
    expect(result.stdout).toContain("selected 3.18.10");
  });

  test("pins the explicitly requested minor version among cached versions", () => {
    const { stateDir, sources, run } = fixture({ versions: ["3.9.0", "3.10.0"] });
    const result = run("--review-helper-version=3.10.0", "--apply");
    expect(result.status).toBe(0);
    expect(readFileSync(destination(stateDir))).toEqual(readFileSync(sources.get("3.10.0")!));
    expect(result.stdout).toContain("selected 3.10.0");
  });

  test("ignores systematic and latest aliases as non-version package entries", () => {
    const { stateDir, sources, run } = fixture({ versions: ["3.21.8"], aliases: ["systematic", "latest"] });
    const result = run("--review-helper-version=3.21.8", "--apply");
    expect(result.status).toBe(0);
    expect(readFileSync(destination(stateDir))).toEqual(readFileSync(sources.get("3.21.8")!));
    expect(result.stdout).toContain("selected 3.21.8");
    expect(result.stdout).not.toContain("selected latest");
    expect(result.stdout).not.toContain("selected latest");
    expect(result.stdout).not.toContain("selected systematic");
  });

  test("anchors version selection to the intended package root despite an enumerated nested decoy", () => {
    const { home, stateDir, sources, anchorPath, run } = fixture({ versions: ["3.20.0", "3.21.0"] });
    const packages = resolve(home, ".cache/opencode/packages");
    const decoy = resolve(packages, "other-package/node_modules/@fro.bot/systematic@9.99.99/skills/ce-review/scripts/validate-review.mjs");
    mkdirSync(resolve(decoy, ".."), { recursive: true });
    writeFileSync(decoy, "distinct decoy bytes: nested version 9.99.99\n");
    const enumeration = spawnSync("/usr/bin/find", [packages, "-type", "f", "-path", "*/skills/ce-review/scripts/validate-review.mjs", "-print"], { encoding: "utf8" });
    expect(enumeration.status).toBe(0);
    expect(enumeration.stdout.trim().split("\n")).toContain(decoy);
    const result = run("--review-helper-version=3.21.0", "--apply");
    expect(result.status).toBe(0);
    expect(readFileSync(destination(stateDir))).toEqual(readFileSync(sources.get("3.21.0")!));
    expect(readFileSync(destination(stateDir))).not.toEqual(readFileSync(decoy));
    expect(result.stdout).toContain(sources.get("3.21.0")!);
    expect(result.stdout).toContain("selected 3.21.0");
    const unanchored = run("--review-helper-version=9.99.99", "--apply");
    expect(unanchored.status).not.toBe(0);
    expect(unanchored.stderr).toContain("REVIEW_HELPER_ANCHOR_MISSING");
    expect(unanchored.stderr).toContain("9.99.99");
    expect(unanchored.stderr).toContain(anchorPath);
    expect(readFileSync(destination(stateDir))).toEqual(readFileSync(sources.get("3.21.0")!));
  });
});
