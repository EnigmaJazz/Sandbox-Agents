import { describe, expect, test } from "bun:test";
import { OPERATIONS, SANDBOX_GUARD_CLASS } from "../src/types.ts";
import { ALLOWED_PAYLOAD_KEYS, HOST_MUTATION_OPERATIONS, HOST_READ_OPERATIONS, HostToolPolicy } from "../src/validation.ts";

describe("operation registry parity", () => {
  test("OPERATIONS exactly matches the sandbox guard registry without duplicates", () => {
    const operations = new Set<string>(OPERATIONS);
    const guardedOperations = new Set(Object.keys(SANDBOX_GUARD_CLASS));

    expect(operations.size).toBe(OPERATIONS.length);
    expect([...operations].filter((operation) => !guardedOperations.has(operation))).toEqual([]);
    expect([...guardedOperations].filter((operation) => !operations.has(operation))).toEqual([]);
  });

  test("reviewPipelineRun is registered as a host mutation with a payload allowlist", () => {
    expect(OPERATIONS).toContain("reviewPipelineRun");
    expect(SANDBOX_GUARD_CLASS).toHaveProperty("reviewPipelineRun", "exempt-from-sandbox-guard");
    expect(HOST_MUTATION_OPERATIONS).toContain("reviewPipelineRun");
    expect(ALLOWED_PAYLOAD_KEYS).toHaveProperty("reviewPipelineRun", ["projectDir", "phase", "reviewer", "stdin", "inputRef", "runId"]);
  });

  test("reviewDiffRead is a host read with only runId and optional slice", () => {
    expect(OPERATIONS).toContain("reviewDiffRead");
    expect(SANDBOX_GUARD_CLASS).toHaveProperty("reviewDiffRead", "exempt-from-sandbox-guard");
    expect(HOST_READ_OPERATIONS).toContain("reviewDiffRead");
    expect(HOST_MUTATION_OPERATIONS).not.toContain("reviewDiffRead");
    expect(new HostToolPolicy([]).decide("reviewDiffRead", undefined)).toEqual({
      allowed: true, access: "read", reasonCode: "HOST_READ_OPEN",
    });
    expect(ALLOWED_PAYLOAD_KEYS).toHaveProperty("reviewDiffRead", ["projectDir", "runId", "slice"]);
  });

  test("reviewPersist is registered as a host mutation without artifact content", () => {
    expect(OPERATIONS).toContain("reviewPersist");
    expect(SANDBOX_GUARD_CLASS).toHaveProperty("reviewPersist", "exempt-from-sandbox-guard");
    expect(HOST_MUTATION_OPERATIONS).toContain("reviewPersist");
    expect(ALLOWED_PAYLOAD_KEYS).toHaveProperty("reviewPersist", ["projectDir", "runId", "finalizeRef", "mode"]);
  });
});
