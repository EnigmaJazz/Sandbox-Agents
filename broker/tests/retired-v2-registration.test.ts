/**
 * v6 §28 — the eight retired v2 SDD operations must no longer be registrable,
 * dispatchable, classified, or payload-allowed, while `sddAttemptGrant` (the
 * one sanctioned `sdd-attempt` mutation) stays fully registered.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ALLOWED_PAYLOAD_KEYS,
  HOST_MUTATION_OPERATIONS,
  HOST_READ_OPERATIONS,
  ValidationError,
  assertPayloadKeys,
  hostToolAccess,
} from "../src/validation.ts";
import { OPERATIONS } from "../src/types.ts";
import { buildSddAttemptGrantArgv } from "../src/sdd-runtime.ts";
import { buildSddAttemptGrantAsk } from "../../opencode/plugins/lib/host-tool-approval.ts";

/** Broker operation names retired by v6 §28. */
const RETIRED_OPERATIONS = [
  "sddVerifyValidate",
  "sddAttemptStatus",
  "sddAttemptAcquire",
  "sddAttemptBegin",
  "sddAttemptRescope",
  "sddAttemptFinish",
  "sddAttemptReset",
  "sddAttemptSettle",
] as const;

/** Plugin tool names that must remain denied in the permission fragment. */
const RETIRED_HOST_TOOLS = [
  "host_sdd_verify_validate",
  "host_sdd_attempt_status",
  "host_sdd_attempt_acquire",
  "host_sdd_attempt_begin",
  "host_sdd_attempt_rescope",
  "host_sdd_attempt_finish",
  "host_sdd_attempt_reset",
  "host_sdd_attempt_settle",
] as const;

describe("v6 §28 retired v2 registration removal", () => {
  test("the protocol operation union no longer contains any retired op", () => {
    for (const op of RETIRED_OPERATIONS) {
      expect(OPERATIONS).not.toContain(op);
    }
  });

  test("the retired ops are neither read- nor mutation-classified", () => {
    for (const op of RETIRED_OPERATIONS) {
      expect(HOST_READ_OPERATIONS).not.toContain(op);
      expect(HOST_MUTATION_OPERATIONS).not.toContain(op);
      expect(() => hostToolAccess(op)).toThrow(ValidationError);
    }
  });

  test("the retired ops have no payload allowlist and reject any payload", () => {
    for (const op of RETIRED_OPERATIONS) {
      expect(ALLOWED_PAYLOAD_KEYS[op]).toBeUndefined();
      expect(() => assertPayloadKeys(op, { projectDir: "/repo" })).toThrow(ValidationError);
    }
  });

  test("sddAttemptGrant stays registered, orchestrator-only, and allowlisted", () => {
    expect(OPERATIONS).toContain("sddAttemptGrant");
    expect(HOST_MUTATION_OPERATIONS).toContain("sddAttemptGrant");
    expect(HOST_READ_OPERATIONS).not.toContain("sddAttemptGrant");
    expect(hostToolAccess("sddAttemptGrant")).toBe("mutation");
    expect(ALLOWED_PAYLOAD_KEYS.sddAttemptGrant).toContain("roots");
    expect(() =>
      assertPayloadKeys("sddAttemptGrant", {
        projectDir: "/repo",
        change: "change",
        roots: ["/home/james/a"],
        changeInstance: "instance-token",
        requestId: "grant-request",
        actor: "gentle-orchestrator",
        reason: "widen",
      }),
    ).not.toThrow();
    expect(() =>
      assertPayloadKeys("sddAttemptGrant", { projectDir: "/repo", token: "nope" }),
    ).toThrow(ValidationError);
  });

  test("sddAttemptGrant still builds its exact argv and approval ask", () => {
    expect(
      buildSddAttemptGrantArgv({
        binary: "gentle-ai",
        projectRoot: "/home/james/peak-redir",
        change: "peak-hour-routing",
        roots: ["/home/james/a", "/home/james/b"],
        changeInstance: "instance-token",
        requestId: "grant-request",
        actor: "gentle-orchestrator",
        reason: "widen roots",
      }),
    ).toEqual([
      "gentle-ai",
      "sdd-attempt",
      "grant",
      "--cwd",
      "/home/james/peak-redir",
      "--change",
      "peak-hour-routing",
      "--root",
      "/home/james/a",
      "--root",
      "/home/james/b",
      "--change-instance",
      "instance-token",
      "--request-id",
      "grant-request",
      "--actor",
      "gentle-orchestrator",
      "--reason",
      "widen roots",
    ]);
    const ask = buildSddAttemptGrantAsk({
      change: "peak-hour-routing",
      roots: ["/home/james/a", "/home/james/b"],
      changeInstance: "instance-token",
      requestId: "grant-request",
      actor: "gentle-orchestrator",
      reason: "widen roots",
    });
    expect(ask.permission).toBe("host_sdd_attempt_grant");
    expect(ask.metadata.operation).toBe("sddAttemptGrant");
    expect(ask.metadata.details.rootCount).toBe(2);
    expect(ask.always).toEqual([]);
  });

  test("the permission fragment denies the eight retired tools and keeps grant ask", () => {
    const fragment = readFileSync(
      resolve(import.meta.dir, "../../opencode/config-fragments/sandbox-permissions.jsonc"),
      "utf8",
    );
    for (const tool of RETIRED_HOST_TOOLS) {
      expect(fragment).toContain(`"${tool}": "deny"`);
    }
    expect(fragment).toContain('"host_sdd_attempt_grant": "ask"');
  });
});
