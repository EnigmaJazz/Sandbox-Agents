/**
 * Gated integration suite (SYSTEM_PROMPT.md §28, spec §27 Gate 5).
 *
 * Requires a REAL msb installation + a live broker. Skipped unless
 * SANDBOX_GATED_TESTS=integration (or "all") is set:
 *
 *   SANDBOX_GATED_TESTS=integration bun test tests/integration/
 *
 * Gate 1: these tests are NOT run and are NOT self-certified — Gate 5 is a
 * manual gate. They exist so the manual checklist is machine-checkable once
 * the environment is ready.
 */
import { describe, expect, test } from "bun:test";

const GATE = process.env.SANDBOX_GATED_TESTS ?? "";
const enabled = GATE === "integration" || GATE === "all";

describe("integration: lazy creation, reuse, isolation, read switch (Gate 5)", () => {
  test.skip(
    "read-only investigation creates ZERO workers (§28 lazy creation)",
    () => {
      // drive broker workerStatus/listWorkers after host reads; expect no workers
      expect(false).toBe(true);
    },
    enabled,
  );

  test.skip(
    "first write/bash creates EXACTLY ONE worker (§28 lazy creation)",
    () => {
      expect(false).toBe(true);
    },
    enabled,
  );

  test.skip(
    "subsequent ops in the same session reuse the same worker (§28 worker reuse)",
    () => {
      expect(false).toBe(true);
    },
    enabled,
  );

  test.skip(
    "different session ID gets a different worker (§28 session separation, S13)",
    () => {
      expect(false).toBe(true);
    },
    enabled,
  );

  test.skip(
    "after a sandbox edit, sandbox_read returns the modified contents (§28 read switch, S5)",
    () => {
      expect(false).toBe(true);
    },
    enabled,
  );

  test.skip(
    "approved external read root is readable while sandbox is active (S6)",
    () => {
      expect(false).toBe(true);
    },
    enabled,
  );

  test.skip(
    "external write fails or requires explicit approval (§28 external write)",
    () => {
      expect(false).toBe(true);
    },
    enabled,
  );

  test.skip(
    "host escape: worker cannot touch host /tmp proof file, SSH creds, host project, Docker socket, systemd (§28 host escape)",
    () => {
      expect(false).toBe(true);
    },
    enabled,
  );
});
