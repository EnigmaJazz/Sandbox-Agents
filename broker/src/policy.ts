/**
 * Resource broker (SYSTEM_PROMPT.md §22).
 *
 * Budget heuristic:
 * - reserve >= 25% CPU and >= 25% RAM for the host;
 * - never consume the final `reserveMemBytes` (default 4 GiB) of host RAM;
 * - aggregate caps from configuration;
 * - worker creation is REJECTED when the pool is exhausted (queueing is
 *   preferred over uncontrolled oversubscription).
 */
import { cpus, totalmem } from "node:os";
import { readFileSync } from "node:fs";
import type { ResourceConfig } from "./config.ts";

export interface HostResources {
  cpuCount: number;
  totalMemBytes: number;
}

export interface WorkerAllocation {
  cpu: number;
  memBytes: number;
}

export interface WorkerPool {
  allocations: WorkerAllocation[];
}

export interface Budget {
  perWorkerCpu: number;
  perWorkerMemBytes: number;
  maxAggregateCpu: number;
  maxAggregateMemBytes: number;
  maxWorkers: number;
  hostReservedCpu: number;
  hostReservedMemBytes: number;
}

export class PolicyError extends Error {
  readonly code: string = "policy";
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Total RAM from /proc/meminfo when available, else os.totalmem(). */
export function discoverHostResources(): HostResources {
  const cpuCount = cpus().length;
  let totalMemBytes = totalmem();
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const match = /^MemTotal:\s+(\d+)\s*kB$/m.exec(meminfo);
    if (match?.[1]) {
      totalMemBytes = Number(match[1]) * 1024;
    }
  } catch {
    /* fall back to os.totalmem() */
  }
  return { cpuCount, totalMemBytes };
}

export function computeBudget(resources: HostResources, cfg: ResourceConfig): Budget {
  const reservedCpu = Math.max(
    1,
    Math.ceil(resources.cpuCount * cfg.reserveCpuFraction),
  );
  const reservedMem = Math.max(
    Math.floor(resources.totalMemBytes * cfg.reserveMemFraction),
    cfg.reserveMemBytes,
  );
  const availCpu = Math.max(1, resources.cpuCount - reservedCpu);
  const availMem = Math.max(0, resources.totalMemBytes - reservedMem);

  const perWorkerCpu = clamp(cfg.perWorkerCpu, 0.25, cfg.maxPerWorkerCpu);
  const perWorkerMem = clamp(
    cfg.perWorkerMemBytes,
    128 * 1024 * 1024,
    cfg.maxPerWorkerMemBytes,
  );

  const maxAggregateCpu = Math.min(cfg.maxAggregateCpu, availCpu);
  const maxAggregateMem = Math.min(cfg.maxAggregateMemBytes, availMem);

  const byCpu = Math.max(0, Math.floor(maxAggregateCpu / perWorkerCpu));
  const byMem = Math.max(0, Math.floor(maxAggregateMem / perWorkerMem));
  const maxWorkers = Math.min(cfg.maxWorkers, byCpu, byMem);

  return {
    perWorkerCpu,
    perWorkerMemBytes: perWorkerMem,
    maxAggregateCpu,
    maxAggregateMemBytes: maxAggregateMem,
    maxWorkers,
    hostReservedCpu: reservedCpu,
    hostReservedMemBytes: reservedMem,
  };
}

export type Admission =
  | { allowed: true; cpu: number; memBytes: number }
  | {
      allowed: false;
      reason: string;
      /** Queueing is preferred to oversubscription (§22). */
      queueHint: number;
      /**
       * True when the refusal is TRANSIENT pool exhaustion (aggregate caps or
       * max workers) — the request may wait for a freed slot in the FIFO
       * queue. False for request-level problems (invalid / above-policy)
       * that queueing can never fix — those must fail immediately.
       */
      queueable: boolean;
    };

export function checkAdmission(
  pool: WorkerPool,
  budget: Budget,
  requested: Partial<WorkerAllocation> = {},
): Admission {
  const cpu = requested.cpu ?? budget.perWorkerCpu;
  const memBytes = requested.memBytes ?? budget.perWorkerMemBytes;
  if (cpu <= 0 || memBytes <= 0) {
    return { allowed: false, reason: "invalid resource request", queueHint: 0, queueable: false };
  }
  if (cpu > budget.perWorkerCpu || memBytes > budget.perWorkerMemBytes) {
    return {
      allowed: false,
      reason: `resource request above policy (max ${budget.perWorkerCpu} vCPU / ${formatBytes(budget.perWorkerMemBytes)})`,
      queueHint: 0,
      queueable: false,
    };
  }
  const aggCpu = pool.allocations.reduce((a, w) => a + w.cpu, 0);
  const aggMem = pool.allocations.reduce((a, w) => a + w.memBytes, 0);
  if (aggCpu + cpu > budget.maxAggregateCpu) {
    return {
      allowed: false,
      reason: "aggregate vCPU pool exhausted",
      queueHint: 1,
      queueable: true,
    };
  }
  if (aggMem + memBytes > budget.maxAggregateMemBytes) {
    return {
      allowed: false,
      reason: "aggregate memory pool exhausted",
      queueHint: 1,
      queueable: true,
    };
  }
  if (pool.allocations.length >= budget.maxWorkers) {
    return {
      allowed: false,
      reason: `maximum concurrent workers reached (${budget.maxWorkers})`,
      queueHint: pool.allocations.length - budget.maxWorkers + 1,
      queueable: true,
    };
  }
  return { allowed: true, cpu, memBytes };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
