/**
 * Microsandbox (`msb`) adapter (SYSTEM_PROMPT.md §6, §21).
 *
 * - Every invocation is an ARGV VECTOR: no shell strings, no interpolation.
 * - The worker image is fixed by policy; the adapter never accepts an image
 *   from a caller (S11).
 * - No secrets are ever passed to workers (S8/S9): env is restricted to a
 *   static allowlist and keys matching credential patterns are rejected.
 * - Timeouts are enforced by killing the spawned process (SIGTERM -> SIGKILL).
 * - The spawn function is injectable for unit tests (fake spawn). The fake is
 *   used by broker/tests/msb.test.ts ONLY; production uses `spawnFromHost`.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { BrokerConfig } from "./config.ts";
import type { WorkerState } from "./types.ts";
import { ValidationError } from "./validation.ts";

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SpawnOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  maxOutputBytes?: number;
}

export type SpawnFn = (args: string[], opts: SpawnOptions) => Promise<SpawnResult>;

/**
 * Render a byte count as an msb memory size string (e.g. 2147483648 -> "2048M").
 * msb 0.6.9 resource.conf requires a size STRING (Gate 3 finding: integers are
 * rejected). Round to whole MiB.
 */
export function memSizeString(bytes: number): string {
  const MiB = 1024 * 1024;
  const mebibytes = Math.max(1, Math.round(bytes / MiB));
  return `${mebibytes}M`;
}

/**
 * Generic direct-process spawner: argv[0] is the absolute executable path,
 * remaining entries are argument vectors. No shell is ever involved.
 */
export function spawnArgv(argv: readonly string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
  const binary = argv[0];
  if (!binary || binary.includes("\u0000")) {
    return Promise.reject(new ValidationError("invalid executable path"));
  }
  return new Promise<SpawnResult>((resolve) => {
    const child = spawn(binary, argv.slice(1), {
      shell: false,
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const cap = opts.maxOutputBytes ?? 512 * 1024;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < cap) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < cap) stderr += chunk.toString("utf8");
    });
    let timedOut = false;
    let settled = false;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, opts.timeoutMs ?? 120_000);
    timer.unref();
    child.on("error", (err) => {
      stderr = `spawn error: ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

// ---------------------------------------------------------------------------
// Test seam — replaced ONLY by broker/tests/msb.test.ts.
// ---------------------------------------------------------------------------

let spawnImpl: SpawnFn = (argv, opts) => spawnArgv(argv, opts);

/** Test seam (unit tests only). Production code never calls this. */
export function setSpawnImpl(fn: SpawnFn): void {
  spawnImpl = fn;
}

/** Test seam. */
export function getSpawnImpl(): SpawnFn {
  return spawnImpl;
}

export class MsbError extends Error {
  readonly code = "worker" as const;
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "MsbError";
  }
}

/** Credential-shaped env keys are always rejected (S8/S9). */
const CREDENTIAL_KEY_RE = /(token|secret|password|credential|auth|api[_-]?key|private[_-]?key)/i;

export function assertWorkerEnv(
  env: Record<string, string> | undefined,
  allowedKeys: readonly string[],
): Record<string, string> | undefined {
  if (env === undefined || env === null) return undefined;
  if (typeof env !== "object" || Array.isArray(env)) {
    throw new ValidationError("env must be an object");
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_KEY_RE.test(key)) {
      throw new ValidationError(`env key '${key}' looks like a credential and is always rejected (S8/S9)`);
    }
    if (!allowed.has(key)) {
      throw new ValidationError(`env key '${key}' is not on the worker env allowlist`);
    }
    const value = env[key];
    if (typeof value !== "string") {
      throw new ValidationError(`env value for '${key}' must be a string`);
    }
    if (value.length === 0 || value.length > 4096) {
      throw new ValidationError(`env value for '${key}' out of size bounds`);
    }
  }
  return env;
}

export interface WorkerSpec {
  name: string;
  cpu: number;
  memBytes: number;
  image: string;
  /** Paths where generated msb config files will be written (state dir). */
  configDir: string;
  networkMode: "deny-by-default";
}

export class MsbAdapter {
  constructor(private readonly config: BrokerConfig) {}

  private async run(args: string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
    const result = await spawnImpl([this.config.msbBinary, ...args], {
      timeoutMs: opts.timeoutMs ?? this.config.resource.execTimeoutMsDefault,
      cwd: opts.cwd,
      env: opts.env,
      maxOutputBytes: opts.maxOutputBytes ?? this.config.resource.outputMaxBytes,
    });
    if (result.timedOut) {
      throw new MsbError(`msb ${args[0] ?? "?"} timed out`, args[0]);
    }
    return result;
  }

  /**
   * Create a worker from policy. Conf files are GENERATED from trusted
   * policy (never from request fields) and written 0600 into the state dir.
   */
  async createWorker(spec: WorkerSpec): Promise<void> {
    mkdirSync(spec.configDir, { recursive: true, mode: 0o700 });
    const fsConf = join(spec.configDir, "fs.conf");
    const netConf = join(spec.configDir, "net.conf");
    const resourceConf = join(spec.configDir, "resource.conf");
    const runtimeConf = join(spec.configDir, "runtime.conf");
    const secretConf = join(spec.configDir, "secret.conf");

    // FS: worker project workdir only; host is NOT mounted (S11).
    // fs.conf accepts ONLY mounts/patch_files/patches (msb 0.6.9, Gate 3).
    writeFileSync(fsConf, "{}\n", { mode: 0o600 });
    // Network: deny-by-default (S12) — policy enum is none|public|open.
    writeFileSync(
      netConf,
      JSON.stringify({ policy: "none" }, null, 2) + "\n",
      { mode: 0o600 },
    );
    // resource.conf: cpus (plural) + memory as a SIZE STRING (e.g. "2048M").
    writeFileSync(
      resourceConf,
      JSON.stringify({ cpus: spec.cpu, memory: memSizeString(spec.memBytes) }, null, 2) + "\n",
      { mode: 0o600 },
    );
    // No secrets, no OAuth, no host mounts, no devices (S8/S9/S11).
    // runtime.conf: `capabilities` is NOT a field (Gate 3 finding); use
    // security "restricted"; /work must exist -> --mkdir /work below.
    writeFileSync(
      runtimeConf,
      JSON.stringify({ security: "restricted", workdir: "/work" }, null, 2) + "\n",
      { mode: 0o600 },
    );
    // secret.conf is the UNWRAPPED secret-name map (no `secrets` wrapper).
    writeFileSync(secretConf, "{}\n", { mode: 0o600 });

    const args = [
      "create",
      spec.image,
      "--conf",
      runtimeConf,
      "--net-conf",
      netConf,
      "--resource-conf",
      resourceConf,
      "--fs-conf",
      fsConf,
      "--secret-conf",
      secretConf,
      "-n",
      spec.name,
      "-c",
      String(spec.cpu),
      "--max-cpus",
      String(spec.cpu),
      "--mkdir",
      "/work",
    ];
    const res = await this.run(args, { timeoutMs: 180_000 });
    if (res.status !== 0 && !res.timedOut) {
      throw new MsbError(`msb create failed (status ${res.status}): ${trim(res.stderr || res.stdout)}`);
    }
  }

  /** Run a command inside the worker. argv vector only. */
  async exec(
    workerName: string,
    argv: string[],
    opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<SpawnResult> {
    const env = assertWorkerEnv(opts.env, this.config.resource.envAllowedKeys);
    const envArgs: string[] = [];
    if (env) {
      for (const [k, v] of Object.entries(env)) envArgs.push("-e", `${k}=${v}`);
    }
    const args = [
      "exec",
      workerName,
      // Gate 3 finding: msb exposes the host /dev/kvm (10,232) into the guest,
      // mode 600 root:root — a root guest user can open it (nested KVM). Run
      // every worker command as a non-root user to deny access (S11).
      "-u",
      this.config.resource.workerUser,
      ...envArgs,
      ...(opts.cwd ? ["-w", opts.cwd] : []),
      ...(opts.timeoutMs ? ["--timeout", String(cappedTimeoutMs(opts.timeoutMs, this.config.resource.execTimeoutMsMax))] : []),
      "--",
      ...argv,
    ];
    const res = await this.run(args, {
      // Never let a caller extend the spawn beyond policy + margin.
      timeoutMs:
        cappedTimeoutMs(
          opts.timeoutMs ?? this.config.resource.execTimeoutMsDefault,
          this.config.resource.execTimeoutMsMax,
        ) + 10_000,
    });
    return res;
  }

  async copyIn(workerName: string, hostSrc: string, workerDest: string): Promise<void> {
    const args = ["copy", hostSrc, `${workerName}:${workerDest}`];
    const res = await this.run(args);
    if (res.status !== 0 && !res.timedOut) {
      throw new MsbError(`msb copy failed (status ${res.status}): ${trim(res.stderr || res.stdout)}`);
    }
  }

  async copyOut(workerName: string, workerSrc: string, hostDest: string): Promise<void> {
    const args = ["copy", `${workerName}:${workerSrc}`, hostDest];
    const res = await this.run(args);
    if (res.status !== 0 && !res.timedOut) {
      throw new MsbError(`msb copy failed (status ${res.status}): ${trim(res.stderr || res.stdout)}`);
    }
  }

  async stop(workerName: string): Promise<void> {
    const res = await this.run(["stop", workerName], { timeoutMs: 60_000 });
    if (res.status !== 0 && !res.timedOut) {
      throw new MsbError(`msb stop failed (status ${res.status})`);
    }
  }

  async remove(workerName: string): Promise<void> {
    const res = await this.run(["remove", workerName], { timeoutMs: 60_000 });
    if (res.status !== 0 && !res.timedOut) {
      throw new MsbError(`msb remove failed (status ${res.status})`);
    }
  }

  async list(): Promise<string[]> {
    const res = await this.run(["list"], { timeoutMs: 30_000 });
    if (res.status !== 0 && !res.timedOut) {
      throw new MsbError(`msb list failed (status ${res.status})`);
    }
    return res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  async status(workerName: string): Promise<WorkerState> {
    const res = await this.run(["status", workerName], { timeoutMs: 30_000 });
    if (res.status !== 0 && !res.timedOut) {
      return "FAILED";
    }
    const out = res.stdout.toLowerCase();
    if (out.includes("running") || out.includes("active")) return "ACTIVE";
    if (out.includes("paused") || out.includes("stopped")) return "PAUSED";
    return "ACTIVE";
  }

  workerNameFor(sessionID: string): string {
    return `${this.config.workerNamePrefix}-${sessionID}`;
  }
}

function cappedTimeoutMs(requested: number, max: number): number {
  return Math.max(1_000, Math.min(requested, max));
}

function trim(s: string): string {
  const t = s.trim();
  return t.length > 2000 ? `${t.slice(0, 2000)}…` : t;
}
