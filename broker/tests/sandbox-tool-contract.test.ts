import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
const schema = new Proxy({}, {
  get: () => () => schema,
});
mock.module("@opencode-ai/plugin", () => ({ tool: (definition: unknown) => definition }));
mock.module("zod", () => ({
  z: new Proxy({}, {
    get: () => () => schema,
  }),
}));
const { applyTargetedEdit } = await import("../../opencode/plugins/sandbox-tools.ts");

const sandboxTools = readFileSync(
  new URL("../../opencode/plugins/sandbox-tools.ts", import.meta.url),
  "utf8",
);
const service = readFileSync(new URL("../src/service.ts", import.meta.url), "utf8");

function refusalReason(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error("Expected targeted edit to be refused");
}

test("sandbox_edit replaces one unique match in place", () => {
  expect(applyTargetedEdit("const value = 1;\n", "1", "2")).toBe("const value = 2;\n");
});

test("sandbox_edit refuses zero matches with a named reason", () => {
  expect(refusalReason(() => applyTargetedEdit("alpha", "missing", "beta"))).toBe(
    "sandbox_edit: oldString was not found",
  );
});

test("sandbox_edit refuses multiple matches unless replaceAll is true", () => {
  expect(refusalReason(() => applyTargetedEdit("a a", "a", "b"))).toBe(
    "sandbox_edit: oldString matched multiple times; set replaceAll to true to replace all",
  );
});

test("sandbox_edit replaces all matches when replaceAll is true", () => {
  expect(applyTargetedEdit("a a a", "a", "b", true)).toBe("b b b");
});

test("sandbox_edit refuses an empty oldString with a named reason", () => {
  expect(refusalReason(() => applyTargetedEdit("content", "", "replacement"))).toBe(
    "sandbox_edit: oldString must not be empty",
  );
});

test("sandbox_edit refuses edits that would blank the file with a named reason", () => {
  expect(refusalReason(() => applyTargetedEdit("only content", "only content", ""))).toBe(
    "sandbox_edit: edit would leave the file empty",
  );
});

test("sandbox_edit changes a small region of a large file without retranscribing it", () => {
  const prefix = "unchanged-before\n".repeat(100_000);
  const suffix = "unchanged-after\n".repeat(100_000);
  const result = applyTargetedEdit(`${prefix}target${suffix}`, "target", "updated");
  expect(result).toBe(`${prefix}updated${suffix}`);
  expect(result.length).toBeGreaterThan(2_000_000);
});

test("sandbox_edit and sandbox_write descriptions distinguish targeted and whole-file edits", () => {
  expect(sandboxTools).toContain("replacing only the specified text");
  expect(sandboxTools).toContain("whole-file replacement, use sandbox_write");
  expect(sandboxTools).toContain("replace the entire file contents");
  expect(sandboxTools).toContain("sandbox_edit for targeted text changes");
});

test("sandbox_apply_patch gives an actionable remedy for invalid unified diffs", () => {
  expect(service).toContain("include at least one unchanged context line");
  expect(service).toContain("end-of-file append-only hunk is valid");
  expect(sandboxTools).toContain("EOF append-only hunks may");
  expect(sandboxTools).toContain("sandbox_apply_patch failed:");
});
