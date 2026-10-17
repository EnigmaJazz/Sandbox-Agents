import { describe, expect, test } from "bun:test";
import { OPERATIONS, SANDBOX_GUARD_CLASS } from "../src/types.ts";

describe("operation registry parity", () => {
  test("OPERATIONS exactly matches the sandbox guard registry without duplicates", () => {
    const operations = new Set<string>(OPERATIONS);
    const guardedOperations = new Set(Object.keys(SANDBOX_GUARD_CLASS));

    expect(operations.size).toBe(OPERATIONS.length);
    expect([...operations].filter((operation) => !guardedOperations.has(operation))).toEqual([]);
    expect([...guardedOperations].filter((operation) => !operations.has(operation))).toEqual([]);
  });
});
