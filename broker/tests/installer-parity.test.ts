import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Read the repository scripts from the checkout root. broker/tests/ -> repo root.
const repoRoot = resolve(import.meta.dir, "../..");
const PLUGINS_DIR = resolve(repoRoot, "opencode/plugins");
const PLUGINS_LIB_DIR = resolve(repoRoot, "opencode/plugins/lib");

// Expectations are derived from the directory listing, never a hand-maintained
// copy: any .ts file added under opencode/plugins/lib/ (or opencode/plugins/)
// must appear in BOTH installer and rollback lists, so a new library file
// cannot silently miss the install path again.
function pluginTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();
}

const TOP_LEVEL_PLUGIN_FILES = pluginTsFiles(PLUGINS_DIR);
const LIBRARY_PLUGIN_FILES = pluginTsFiles(PLUGINS_LIB_DIR).map((name) => `lib/${name}`);
const EXPECTED_PLUGIN_FILES = [...TOP_LEVEL_PLUGIN_FILES, ...LIBRARY_PLUGIN_FILES];

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
  test("directory scan discovers the plugin .ts sources", () => {
    // Guards against a renamed/empty scan silently passing every comparison.
    expect(TOP_LEVEL_PLUGIN_FILES.length).toBeGreaterThan(0);
    expect(LIBRARY_PLUGIN_FILES.length).toBeGreaterThan(0);
  });

  for (const script of SCRIPTS) {
    test(`${script} lists every .ts file under opencode/plugins (directory-derived)`, () => {
      expect(sorted(pluginLoopEntries(script))).toEqual(sorted(EXPECTED_PLUGIN_FILES));
    });

    test(`${script} keeps the lib/ subpath for library plugins`, () => {
      const entries = pluginLoopEntries(script);
      for (const libraryFile of LIBRARY_PLUGIN_FILES) {
        expect(entries).toContain(libraryFile);
      }
    });
  }

  test("both scripts cover the same plugin files", () => {
    const installer = pluginLoopEntries(SCRIPTS[0]!);
    const rollback = pluginLoopEntries(SCRIPTS[1]!);
    expect(sorted(installer)).toEqual(sorted(rollback));
    expect(installer.length).toBe(EXPECTED_PLUGIN_FILES.length);
    expect(rollback.length).toBe(EXPECTED_PLUGIN_FILES.length);
  });
});
