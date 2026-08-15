/**
 * Structured read-only host API (SYSTEM_PROMPT.md §8, S10).
 *
 * - Capabilities are enabled ONLY when their fixed executable exists.
 * - Every operation is a fixed argv vector — never a shell string.
 * - Parameters (service/container/path/filter) are validated by
 *   validation.ts before reaching the argv.
 * - Output is capped; this module NEVER mutates the host.
 *
 * §9: there is deliberately NO generic host-shell and NO host mutation in
 * v1. Host mutation is manual or, later, a narrowly scoped action with
 * OpenCode permission "ask".
 */
import { existsSync } from "node:fs";
import type { Operation } from "./types.ts";
import type { HostReadConfig } from "./config.ts";
import type { SpawnFn, SpawnResult } from "./msb.ts";
import {
  assertNoControlChars,
  assertPositiveInt,
  assertProcessFilter,
  assertSandboxPath,
  assertServiceOrContainerName,
  assertSince,
  canonicalizeWithinRoots,
  ValidationError,
} from "./validation.ts";

export interface HostReadOp {
  operation: Operation;
  binary: string;
  /** argv AFTER the binary; parameters are appended after validation. */
  baseArgv: string[];
  payloadKeys: string[];
  outputCapBytes: number;
  readonly readOnly: true;
}

export class HostReadError extends Error {
  readonly code = "internal" as const;
  constructor(message: string) {
    super(message);
    this.name = "HostReadError";
  }
}

/** Build the enabled host-read op table from policy + filesystem reality. */
export function buildHostReadOps(cfg: HostReadConfig): HostReadOp[] {
  const ops: HostReadOp[] = [];
  const add = (
    operation: Operation,
    c: { enabled: boolean; binary: string },
    baseArgv: string[],
    payloadKeys: string[],
    outputCapBytes: number,
  ) => {
    if (!c.enabled) return;
    if (!existsSync(c.binary)) {
      // §8: only enable capabilities whose executable actually exists.
      return;
    }
    ops.push({ operation, binary: c.binary, baseArgv, payloadKeys, outputCapBytes, readOnly: true });
  };
  add("hostSystemSummary", cfg.systemSummary, ["-a"], [], 8 * 1024);
  add("hostMemory", cfg.memory, ["-h"], [], 16 * 1024);
  add("hostDiskUsage", cfg.diskUsage, ["-h"], ["path"], 32 * 1024);
  add("hostNetworkListeners", cfg.networkListeners, ["-lntup"], [], 64 * 1024);
  add("hostProcessList", cfg.processList, ["-eo", "pid,ppid,user,comm,args"], ["filter"], 256 * 1024);
  add("hostServiceStatus", cfg.serviceStatus, ["status"], ["service"], 64 * 1024);
  add("hostServiceLogs", cfg.serviceLogs, ["-u"], ["service", "lines", "since"], 512 * 1024);
  add("hostTailscaleStatus", cfg.tailscaleStatus, ["status"], [], 64 * 1024);
  add("hostDockerList", cfg.dockerList, ["ps", "-a"], [], 128 * 1024);
  add("hostDockerLogs", cfg.dockerLogs, ["logs"], ["container", "lines"], 512 * 1024);
  return ops;
}

export interface HostReadExecutorOptions {
  spawn: SpawnFn;
  ops: HostReadOp[];
  approvedReadRoots: string[];
  logLinesMax: number;
  outputMaxBytes: number;
}

export class HostReadExecutor {
  constructor(private readonly opts: HostReadExecutorOptions) {}

  has(operation: Operation): boolean {
    return this.opts.ops.some((o) => o.operation === operation);
  }

  private opFor(operation: Operation): HostReadOp {
    const op = this.opts.find((o) => o.operation === operation);
    if (!op) {
      throw new HostReadError(
        `host capability '${operation}' is not enabled (binary missing or policy-disabled)`,
      );
    }
    return op;
  }

  async execute(operation: Operation, payload: Record<string, unknown> | undefined): Promise<{ stdout: string; stderr: string; status: number | null }> {
    const op = this.opFor(operation);
    const argv = this.buildArgv(op, payload);
    const result: SpawnResult = await this.opts.spawn(argv, {
      timeoutMs: 60_000,
      maxOutputBytes: op.outputCapBytes,
    });
    if (result.timedOut) {
      throw new HostReadError(`host read '${operation}' timed out`);
    }
    let stdout = truncate(result.stdout, op.outputCapBytes);
    if (operation === "hostProcessList" && payload?.filter) {
      // No shell involved: filter the already-produced output in-process.
      const needle = String(payload.filter);
      stdout = stdout
        .split("\n")
        .filter((line) => line.includes(needle))
        .join("\n");
    }
    return { stdout, stderr: truncate(result.stderr, 16 * 1024), status: result.status };
  }

  /**
   * Parameter validation + argv assembly (pure; unit-tested).
   * Returns the FULL vector: argv[0] is the fixed absolute binary path.
   */
  buildArgv(op: HostReadOp, payload: Record<string, unknown> | undefined): string[] {
    const argv = [op.binary, ...op.baseArgv];
    for (const key of op.payloadKeys) {
      if (payload === undefined || payload[key] === undefined) {
        // journalctl -u <service> and systemctl status <service> require a service.
        if (key === "service" || key === "container") {
          throw new ValidationError(`${op.operation} requires '${key}'`);
        }
        continue;
      }
      switch (key) {
        case "service":
        case "container":
          assertServiceOrContainerName(payload[key], key);
          argv.push(String(payload[key]));
          break;
        case "lines": {
          assertPositiveInt(payload[key], this.opts.logLinesMax, "lines");
          argv.push("-n", String(payload[key]));
          break;
        }
        case "since": {
          assertSince(payload[key]);
          const since = payload[key] as string;
          if (since.length > 0) argv.push("--since", since);
          break;
        }
        case "path": {
          // S6: canonicalize + approved-roots check for host-side paths.
          const canonical = canonicalizeWithinRoots(payload[key], this.opts.approvedReadRoots);
          argv.push(canonical);
          break;
        }
        case "filter": {
          assertProcessFilter(payload[key]);
          // Filter is applied to the output in-process (see execute()).
          break;
        }
        default:
          throw new ValidationError(`unhandled payload key '${key}' in ${op.operation}`);
      }
    }
    return argv;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated]`;
}

// Re-exported for tests that want the guard helpers.
export { assertNoControlChars, assertSandboxPath };
