import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Read the repository scripts from the checkout root. broker/tests/ -> repo root.
const repoRoot = resolve(import.meta.dir, "../..");

// The exact seven plugin files the installer and rollback must both cover.
// Library entries keep the `lib/` subpath, matching lib/broker-client.ts.
const EXPECTED_PLUGIN_FILES = [
  "sandbox-tools.ts",
  "routing-guard.ts",
  "lib/broker-client.ts",
  "lib/reviewer-relay-core.ts",
  "lib/session-agent-binding.ts",
  "reviewer-relay-transport.ts",
  "lib/host-tool-approval.ts",
];

const LIBRARY_PLUGIN_FILES = [
  "lib/broker-client.ts",
  "lib/reviewer-relay-core.ts",
  "lib/session-agent-binding.ts",
  "lib/host-tool-approval.ts",
];

const SCRIPTS = ["scripts/install-user-files", "scripts/rollback"];

function readScript(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

// Extract the space-separated file list of the plugin install/remove loop
// (`for f in <entries>; do`) that both scripts use for plugin coverage.
function pluginLoopEntries(relativePath: string): string[] {
  const source = readScript(relativePath);
  const match = /for f in ([^;]+); do/.exec(source);
  if (!match || !match[1]) {
    throw new Error(`no 'for f in ...; do' plugin loop found in ${relativePath}`);
  }
  return match[1].trim().split(/\s+/);
}

function sorted(entries: string[]): string[] {
  return [...entries].sort();
}

describe("installer/rollback plugin coverage parity", () => {
  for (const script of SCRIPTS) {
    test(`${script} lists all seven plugin files`, () => {
      expect(sorted(pluginLoopEntries(script))).toEqual(sorted(EXPECTED_PLUGIN_FILES));
    });

    test(`${script} keeps the lib/ subpath for library plugins`, () => {
      const entries = pluginLoopEntries(script);
      for (const libraryFile of LIBRARY_PLUGIN_FILES) {
        expect(entries).toContain(libraryFile);
      }
    });
  }

  test("both scripts cover the same seven plugin files", () => {
    const installer = pluginLoopEntries(SCRIPTS[0]!);
    const rollback = pluginLoopEntries(SCRIPTS[1]!);
    expect(sorted(installer)).toEqual(sorted(rollback));
    expect(installer.length).toBe(EXPECTED_PLUGIN_FILES.length);
    expect(rollback.length).toBe(EXPECTED_PLUGIN_FILES.length);
  });
});
