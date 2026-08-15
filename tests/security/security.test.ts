/**
 * Gated security suite (SYSTEM_PROMPT.md §28, §29; spec §27 Gate 7/10).
 *
 * Skipped unless SANDBOX_GATED_TESTS=security (or "all"):
 *
 *   SANDBOX_GATED_TESTS=security bun test tests/security/
 *
 * Gate 1: NOT run, NOT self-certified. Gate 10 (adversarial acceptance) is a
 * manual gate with a separate reviewer agent (docs/threat-model.md §6).
 */
import { describe, expect, test } from "bun:test";

const GATE = process.env.SANDBOX_GATED_TESTS ?? "";
const enabled = GATE === "security" || GATE === "all";

describe("security: secret/OAuth/escape/isolation/fail-closed (Gate 7/10)", () => {
  test.skipIf(!enabled)("secret protection: protected credential paths are unreadable (S7)", () => { expect(false).toBe(true); });

  test.skipIf(!enabled)("OAuth absence: worker has no auth.json and no provider env (S8/S9)", () => { expect(false).toBe(true); });

  test.skipIf(!enabled)("host escape: /tmp proof, SSH creds, host project, Docker socket, systemd (§28)", () => { expect(false).toBe(true); });

  test.skipIf(!enabled)("LAN isolation: worker cannot reach private-network destinations (S12)", () => { expect(false).toBe(true); });

  test.skipIf(!enabled)("fail closed: broker down ⇒ sandbox tool call fails, never runs on host (S14)", () => { expect(false).toBe(true); });

  test.skipIf(!enabled)("host divergence: apply is refused after host changes (S16)", () => { expect(false).toBe(true); });

  test.skipIf(!enabled)("broker argument attacks: full §28 table against the live socket", () => { expect(false).toBe(true); });

  test.skipIf(!enabled)("self-modification: result touching broker/nono/plugin/unit is rejected (S17)", () => { expect(false).toBe(true); });
});
