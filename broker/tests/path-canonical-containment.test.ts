// Canonical containment for SDD archive-compose and task-result path arguments.
//
// `resolveProjectRelativePath` canonicalizes with realpath and re-checks
// containment, so an in-project symlink that points outside the approved root
// must be refused for every path it resolves. A not-yet-existing archive output
// under a real in-project parent stays accepted because only its parent is
// canonicalized.
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../src/validation.ts";
import { buildSddArchiveComposeArgv, buildSddTaskResultArgv } from "../src/sdd-runtime.ts";

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "sdd-canon-"));
  mkdirSync(join(root, "specs"));
  mkdirSync(join(root, "change"));
  writeFileSync(join(root, "specs", "canonical.md"), "canonical");
  writeFileSync(join(root, "change", "delta.md"), "delta");
  return root;
}

/** Create a temp dir outside the project and symlink it inside as `name`. */
function symlinkDirOutside(root: string, name: string): string {
  const outside = mkdtempSync(join(tmpdir(), "sdd-outside-"));
  writeFileSync(join(outside, "secret.md"), "secret");
  symlinkSync(outside, join(root, name));
  return outside;
}

/** Create a temp file outside the project and symlink it inside as `name`. */
function symlinkFileOutside(root: string, name: string): string {
  const outside = mkdtempSync(join(tmpdir(), "sdd-outside-file-"));
  const target = join(outside, "secret.json");
  writeFileSync(target, "{}");
  symlinkSync(target, join(root, name));
  return outside;
}

describe("SDD runtime canonical path containment", () => {
  test("archive-compose refuses a symlinked canonical that escapes the root", () => {
    const root = tempProject();
    let outside = "";
    try {
      try {
        outside = symlinkDirOutside(root, "escape-canonical");
      } catch {
        return; // symlinks unsupported on this filesystem
      }
      expect(() =>
        buildSddArchiveComposeArgv({
          binary: "gentle-ai",
          projectRoot: root,
          canonical: "escape-canonical/secret.md",
          delta: "change/delta.md",
          output: "change/out.md",
        }),
      ).toThrow(ValidationError);
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (outside !== "") rmSync(outside, { recursive: true, force: true });
    }
  });

  test("archive-compose refuses a symlinked delta that escapes the root", () => {
    const root = tempProject();
    let outside = "";
    try {
      try {
        outside = symlinkDirOutside(root, "escape-delta");
      } catch {
        return;
      }
      expect(() =>
        buildSddArchiveComposeArgv({
          binary: "gentle-ai",
          projectRoot: root,
          canonical: "specs/canonical.md",
          delta: "escape-delta/secret.md",
          output: "change/out.md",
        }),
      ).toThrow(ValidationError);
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (outside !== "") rmSync(outside, { recursive: true, force: true });
    }
  });

  test("archive-compose refuses a symlinked output parent that escapes the root", () => {
    const root = tempProject();
    let outside = "";
    try {
      try {
        outside = symlinkDirOutside(root, "escape-output");
      } catch {
        return;
      }
      expect(() =>
        buildSddArchiveComposeArgv({
          binary: "gentle-ai",
          projectRoot: root,
          canonical: "specs/canonical.md",
          delta: "change/delta.md",
          output: "escape-output/new.md",
        }),
      ).toThrow(ValidationError);
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (outside !== "") rmSync(outside, { recursive: true, force: true });
    }
  });

  test("task-result refuses a symlinked input that escapes the root", () => {
    const root = tempProject();
    let outside = "";
    try {
      try {
        outside = symlinkFileOutside(root, "link.json");
      } catch {
        return;
      }
      expect(() =>
        buildSddTaskResultArgv({
          binary: "gentle-ai",
          projectRoot: root,
          phase: "apply",
          input: "link.json",
        }),
      ).toThrow(ValidationError);
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (outside !== "") rmSync(outside, { recursive: true, force: true });
    }
  });

  test("archive-compose accepts a not-yet-existing output under a real in-project parent", () => {
    const root = tempProject();
    try {
      const canonicalRoot = realpathSync(root);
      expect(
        buildSddArchiveComposeArgv({
          binary: "gentle-ai",
          projectRoot: root,
          canonical: "specs/canonical.md",
          delta: "change/delta.md",
          output: "change/not-yet.md",
        }),
      ).toEqual([
        "gentle-ai",
        "sdd-archive-compose",
        "--canonical",
        join(canonicalRoot, "specs", "canonical.md"),
        "--delta",
        join(canonicalRoot, "change", "delta.md"),
        "--output",
        join(canonicalRoot, "change", "not-yet.md"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
