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
  const run = () => spawnSync("bash", [installer, "--verify"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, BROKER_STATE_DIR: stateDir },
  });
  return { home, stateDir, nonoDest, run };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("install-user-files --verify", () => {
  test("returns zero when every installed counterpart matches", () => {
    const { run } = fixture();
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("drift");
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
    expect(result.stdout).not.toContain("drifted without secrets");
  });

  test("names a mode difference and returns non-zero", () => {
    const { home, run } = fixture();
    const target = resolve(home, ".config/systemd/user/sandbox-broker.service");
    chmodSync(target, 0o600);
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`${target}: mode differs`);
  });

  test("does not write while reporting drift", () => {
    const { home, stateDir, nonoDest, run } = fixture();
    const target = resolve(home, ".config/opencode-sandbox/broker.env");
    writeFileSync(target, "drift marker\n");
    const before = {
      content: readFileSync(target, "utf8"),
      mode: lstatSync(target).mode & 0o777,
      nonoLink: readlinkSync(nonoDest),
    };
    const result = run();
    expect(result.status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe(before.content);
    expect(lstatSync(target).mode & 0o777).toBe(before.mode);
    expect(readlinkSync(nonoDest)).toBe(before.nonoLink);
    expect(() => lstatSync(stateDir)).toThrow();
  });
});
