import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const sandboxTools = readFileSync(
  new URL("../../opencode/plugins/sandbox-tools.ts", import.meta.url),
  "utf8",
);
const service = readFileSync(new URL("../src/service.ts", import.meta.url), "utf8");

test("sandbox_edit clearly warns that it replaces the entire file", () => {
  expect(sandboxTools).toContain("ENTIRE file contents");
  expect(sandboxTools).toContain("not a surgical");
});

test("sandbox_apply_patch gives an actionable remedy for invalid unified diffs", () => {
  expect(service).toContain("include at least one unchanged context line");
  expect(service).toContain("end-of-file append-only hunk is valid");
  expect(sandboxTools).toContain("EOF append-only hunks may");
  expect(sandboxTools).toContain("sandbox_apply_patch failed:");
  expect(sandboxTools).toContain("sandbox_edit failed:");
  expect(sandboxTools).toContain("use sandbox_apply_patch for targeted changes");
});
