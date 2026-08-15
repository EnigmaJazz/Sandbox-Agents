/**
 * Resource budget tests (SYSTEM_PROMPT.md §22): reserve >=25% CPU, >=25% RAM,
 * never the final 4 GiB, per-worker caps (§21), pool exhaustion rejection.
 */
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { checkAdmission, computeBudget, discoverHostResources, formatBytes } from "../src/policy.ts";

const GiB = 1024 * 1024 * 1024;

const host16c32g = { cpuCount: 16, totalMemBytes: 32 * GiB };

describe("budget math (§22)", () => {
  test("reserves >=25% CPU for the host", () => {
    const cfg = defaultConfig();
    const budget = computeBudget(host16c32g, cfg.resource);
    expect(budget.hostReservedCpu).toBeGreaterThanOrEqual(Math.ceil(16 * 0.25));
    expect(budget.maxAggregateCpu).toBeLessThanOrEqual(16 - budget.hostReservedCpu);
  });

  test("reserves >=25% RAM and never the final 4 GiB", () => {
    const cfg = defaultConfig();
    const budget = computeBudget(host16c32g, cfg.resource);
    const reserved = budget.hostReservedMemBytes;
    expect(reserved).toBeGreaterThanOrEqual(32 * GiB * 0.25);
    expect(reserved).toBeGreaterThanOrEqual(4 * GiB);
    expect(budget.maxAggregateMemBytes).toBeLessThanOrEqual(32 * GiB - 4 * GiB);
  });

  test("per-worker caps never exceed policy max (2 vCPU / 2 GiB start, 4/4 cap)", () => {
    const cfg = defaultConfig();
    const budget = computeBudget(host16c32g, cfg.resource);
    expect(budget.perWorkerCpu).toBe(2);
    expect(budget.perWorkerMemBytes).toBe(2 * GiB);
    expect(budget.perWorkerCpu).toBeLessThanOrEqual(cfg.resource.maxPerWorkerCpu);
    expect(budget.perWorkerMemBytes).toBeLessThanOrEqual(cfg.resource.maxPerWorkerMemBytes);
  });

  test("max workers is limited by the aggregate pool", () => {
    const cfg = defaultConfig();
    const budget = computeBudget(host16c32g, cfg.resource);
    // 8 GiB aggregate / 2 GiB per worker = 4; 8 vCPU / 2 = 4; cap 4.
    expect(budget.maxWorkers).toBe(4);
  });

  test("a small host yields a smaller pool", () => {
    const cfg = defaultConfig();
    const budget = computeBudget({ cpuCount: 4, totalMemBytes: 8 * GiB }, cfg.resource);
    // avail cpu = 4 - 1 = 3 -> 1 worker; avail mem = 8 - max(2,4) = 4 -> 2 workers.
    expect(budget.maxWorkers).toBe(1);
  });

  test("host discovery returns sane values", () => {
    const r = discoverHostResources();
    expect(r.cpuCount).toBeGreaterThan(0);
    expect(r.totalMemBytes).toBeGreaterThan(1024 ** 3);
  });
});

describe("admission (§22, §28 'resource requests above policy')", () => {
  const cfg = defaultConfig();
  const budget = computeBudget(host16c32g, cfg.resource);

  test("admits within the pool", () => {
    const admission = checkAdmission({ allocations: [] }, budget, {});
    expect(admission.allowed).toBe(true);
  });

  test("rejects requests above per-worker policy", () => {
    const admission = checkAdmission({ allocations: [] }, budget, {
      cpu: 5,
      memBytes: 2 * GiB,
    });
    expect(admission.allowed).toBe(false);
    expect(admission.reason).toMatch(/above policy/);
  });

  test("rejects when aggregate vCPU pool is exhausted", () => {
    const pool = { allocations: Array.from({ length: 4 }, () => ({ cpu: 2, memBytes: 2 * GiB })) };
    const admission = checkAdmission(pool, budget, {});
    expect(admission.allowed).toBe(false);
    expect(admission.reason).toMatch(/exhausted|maximum concurrent/);
  });

  test("rejects when aggregate memory pool is exhausted", () => {
    const pool = { allocations: Array.from({ length: 3 }, () => ({ cpu: 2, memBytes: 3 * GiB })) };
    const admission = checkAdmission(pool, budget, {});
    expect(admission.allowed).toBe(false);
  });

  test("rejects when maximum concurrent workers is reached", () => {
    const pool = { allocations: Array.from({ length: budget.maxWorkers }, () => ({ cpu: 1, memBytes: 1 * GiB })) };
    const admission = checkAdmission(pool, budget, {});
    expect(admission.allowed).toBe(false);
    expect(admission.reason).toMatch(/maximum concurrent workers/);
  });

  test("invalid resource requests are rejected", () => {
    expect(checkAdmission({ allocations: [] }, budget, { cpu: 0 }).allowed).toBe(false);
    expect(checkAdmission({ allocations: [] }, budget, { memBytes: -1 }).allowed).toBe(false);
  });
});

describe("formatBytes", () => {
  test("formats human-readable sizes", () => {
    expect(formatBytes(2 * GiB)).toBe("2.0 GiB");
    expect(formatBytes(512)).toBe("512 B");
  });
});
