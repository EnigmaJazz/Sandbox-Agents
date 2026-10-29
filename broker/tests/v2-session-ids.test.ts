import { describe, expect, test } from "bun:test";
import { validateEnvelope } from "../src/validation.ts";
import { hostSessionBinding } from "../../opencode/plugins/lib/session-agent-binding.ts";

/**
 * V1 of docs/upgrades/opencode-v2.md: the broker needs no change for OpenCode V2. V2 session ids look like
 * `ses_<26 alphanumerics>` (observed on V2 2.2.0, e.g. ses_e7685f69affe4QgQ1ES5hVBiGl, 30 characters) and must pass the
 * same allowlist V1's ids do, in the broker's envelope validation and in the plugin's binding helper.
 */
const V2_SESSION_IDS = ["ses_e7685f69affe4QgQ1ES5hVBiGl", "ses_e7685f54dffepNead7YNI4Jt1V", "ses_e76c8f466ffeqjprc8ZhDGis3o"];

describe("V2 session ids", () => {
  for (const sessionID of V2_SESSION_IDS) {
    test(`the broker envelope accepts ${sessionID}`, () => {
      const envelope = validateEnvelope({ version: 1, id: "req-1", operation: "workerStatus", sessionID });
      expect(envelope.sessionID).toBe(sessionID);
    });

    test(`the plugin binding helper accepts ${sessionID}`, () => {
      expect(hostSessionBinding({ sessionID, agent: "gentle-orchestrator" }, ["gentle-orchestrator"])).toEqual({
        sessionID,
        agent: "gentle-orchestrator",
      });
    });
  }

  test("positive control: ids outside the allowlist are still rejected by both", () => {
    for (const bad of ["ses/evil", "ses evil", "", "a".repeat(65), "ses_é"]) {
      expect(() => validateEnvelope({ version: 1, id: "req-1", operation: "workerStatus", sessionID: bad })).toThrow();
      expect(hostSessionBinding({ sessionID: bad, agent: "x" }, ["x"])).toBeNull();
    }
  });
});
