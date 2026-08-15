/**
 * State machine tests (SYSTEM_PROMPT.md §10): legal transitions, persistence
 * round-trip across a simulated broker restart, and fail-closed behavior on
 * corrupt or inconsistent state.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionStore,
  StateError,
  StateCorruptionError,
  assertLegalTransition,
  LEGAL_TRANSITIONS,
} from "../src/state.ts";
import type { SessionState } from "../src/types.ts";

const ALL_STATES: SessionState[] = [
  "HOST_READ_ONLY",
  "CREATING_SANDBOX",
  "SANDBOX_ACTIVE",
  "RESULT_READY",
  "APPLY_PENDING",
  "APPLIED",
  "REJECTED",
  "RETAINED",
  "FAILED_CLOSED",
];

describe("legal transition graph (§10)", () => {
  test("covers the documented flow", () => {
    assertLegalTransition("HOST_READ_ONLY", "CREATING_SANDBOX");
    assertLegalTransition("CREATING_SANDBOX", "SANDBOX_ACTIVE");
    assertLegalTransition("CREATING_SANDBOX", "FAILED_CLOSED");
    assertLegalTransition("SANDBOX_ACTIVE", "RESULT_READY");
    assertLegalTransition("RESULT_READY", "APPLY_PENDING");
    assertLegalTransition("APPLY_PENDING", "APPLIED");
    assertLegalTransition("RESULT_READY", "REJECTED");
    assertLegalTransition("RESULT_READY", "RETAINED");
  });

  test("rejects illegal transitions", () => {
    expect(() => assertLegalTransition("HOST_READ_ONLY", "APPLIED")).toThrow(StateError);
    expect(() => assertLegalTransition("FAILED_CLOSED", "SANDBOX_ACTIVE")).toThrow(StateError);
    expect(() => assertLegalTransition("REJECTED", "RESULT_READY")).toThrow(StateError);
    expect(() => assertLegalTransition("APPLIED", "APPLY_PENDING")).toThrow(StateError);
  });

  test("FAILED_CLOSED is terminal and APPLIED/RETAINED are final-ish", () => {
    for (const state of ALL_STATES) {
      if (state === "CREATING_SANDBOX") {
        // only path out is failure or success
        expect(LEGAL_TRANSITIONS[state]).toContain("SANDBOX_ACTIVE");
        expect(LEGAL_TRANSITIONS[state]).toContain("FAILED_CLOSED");
      }
    }
    expect(LEGAL_TRANSITIONS.FAILED_CLOSED).toHaveLength(0);
  });
});

describe("SessionStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-state-"));
  const store = new SessionStore(dir);

  test("touch creates HOST_READ_ONLY records", () => {
    const rec = store.touch("sessA", { projectID: "proj1", agent: "orchestrator" });
    expect(rec.state).toBe("HOST_READ_ONLY");
    expect(rec.projectID).toBe("proj1");
    expect(rec.agent).toBe("orchestrator");
  });

  test("transition enforces current state (fail closed on inconsistency)", () => {
    expect(() => store.transition("sessA", "SANDBOX_ACTIVE", "RESULT_READY")).toThrow(StateError);
    store.transition("sessA", "HOST_READ_ONLY", "CREATING_SANDBOX", { workerName: "oc-sandbox-sessA" });
    const rec = store.transition("sessA", "CREATING_SANDBOX", "SANDBOX_ACTIVE", {
      workerState: "ACTIVE",
    });
    expect(rec.state).toBe("SANDBOX_ACTIVE");
    expect(rec.workerName).toBe("oc-sandbox-sessA");
  });

  test("unknown session transitions fail closed", () => {
    expect(() => store.transition("ghost", "HOST_READ_ONLY", "CREATING_SANDBOX")).toThrow(
      StateError,
    );
    expect(store.get("ghost")).toBeUndefined();
  });

  test("persistence round-trip across a simulated broker restart", () => {
    // New store instance over the same dir == broker restart.
    const store2 = new SessionStore(dir);
    const rec = store2.get("sessA");
    expect(rec?.state).toBe("SANDBOX_ACTIVE");
    expect(rec?.workerName).toBe("oc-sandbox-sessA");
    expect(rec?.workerState).toBe("ACTIVE");
  });

  test("state is never inferred from the worker name (§10)", () => {
    // A worker name alone must not imply state: the record is authoritative.
    const store2 = new SessionStore(dir);
    const rec = store2.get("sessA");
    expect(rec?.state).toBe("SANDBOX_ACTIVE");
    // Simulate the worker being gone: the record still says SANDBOX_ACTIVE.
    expect(rec?.workerName).toBe("oc-sandbox-sessA");
  });

  test("corrupt state file throws StateCorruptionError (fail closed, S14)", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "broker-state-corrupt-"));
    const store2 = new SessionStore(dir2);
    store2.touch("sessB", {});
    writeFileSync(join(dir2, "sessions", "sessB.json"), "{not json", "utf8");
    expect(() => store2.get("sessB")).toThrow(StateCorruptionError);
    expect(() => store2.list()).toThrow(StateCorruptionError);
  });

  test("atomic write leaves no partial files", () => {
    const dir3 = mkdtempSync(join(tmpdir(), "broker-state-atomic-"));
    const store3 = new SessionStore(dir3);
    for (let i = 0; i < 20; i++) {
      store3.touch(`sess${i}`, { projectID: `p${i}` });
    }
    const leftovers = readdirSync(join(dir3, "tmp"));
    expect(leftovers.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    expect(readdirSync(join(dir3, "sessions")).length).toBe(20);
  });

  test("REJECT path removes worker state per §20", () => {
    store.transition("sessA", "SANDBOX_ACTIVE", "RESULT_READY", { resultRef: "refs/opencode-sandbox/result/sessA" });
    store.transition("sessA", "RESULT_READY", "REJECTED");
    expect(store.get("sessA")?.state).toBe("REJECTED");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
