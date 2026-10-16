/**
 * Microsandbox (`msb`) adapter (SYSTEM_PROMPT.md §6, §21).
 *
 * - Every invocation is an ARGV VECTOR: no shell strings, no interpolation.
 * - The worker image is fixed by policy; the adapter never accepts an image
 *   from a caller (S11).
 * - No secrets are ever passed to workers (S8/S9): env is restricted to a
 *   static allowlist and keys matching credential patterns are rejected.
 * - Timeouts are enforced by killing the spawned process (SIGTERM -> SIGKILL).
 * - Host `git` argv is hardened here (`hardenGitArgv`): repository-local
 *   execution vectors are neutralized or refused at this single choke point.
 * - The spawn function is injectable for unit tests (fake spawn). The fake is
 *   used by broker/tests/msb.test.ts ONLY; production uses `spawnFromHost`.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { BrokerConfig } from "./config.ts";
import type { WorkerState } from "./types.ts";
import { ValidationError } from "./validation.ts";
import { hardenGitArgv } from "./gitguard.ts";

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * True when stdout exceeded `maxOutputBytes`: the retained text is a
   * byte-capped prefix and the tail was dropped. Absent only on results from a
   * fake spawn that does not model the cap. Exactly-at-cap is NOT truncated.
   */
  outputTruncated?: boolean;
  /** True when stderr exceeded `maxOutputBytes` (see {@link outputTruncated}). */
  stderrTruncated?: boolean;
}

export interface SpawnOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  maxOutputBytes?: number;
  /** When present, the child receives these bytes on stdin (stdio[0] = "pipe"). */
  stdin?: Buffer;
}

export interface SpawnExecOptions extends SpawnOptions {
  /**
   * `"merge"` (default) inherits `process.env` and applies `env` on top
   * (`childEnvironment`); `"replace"` forwards ONLY `env`. Replacement is
   * OPT-IN and exists for the stdin-only review-pipeline helpers.
   */
  envMode?: "merge" | "replace";
}

export type SpawnFn = (args: string[], opts: SpawnOptions) => Promise<SpawnResult>;

/** CRLF -> LF normalization (Gate 3: msb exec PTY path emits \r\n on some hosts). */
export function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

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
/**
 * The effective child environment: `{ ...process.env, ...env }` when `env` is
 * given, else the inherited `process.env`. The guard and the spawned child must
 * read the SAME environment, so both use this merge (mirrors the spawn below).
 */
export function childEnvironment(
  env: Record<string, string> | undefined,
): Record<string, string | undefined> {
  return env ? { ...process.env, ...env } : process.env;
}

/**
 * Byte-exact spawn core shared by `spawnArgv` and `spawnExec`.
 *
 * stdout/stderr accumulate as `Buffer`s, are RETAINED only up to
 * `maxOutputBytes`, and are decoded ONCE at EOF: per-chunk `toString("utf8")`
 * corrupts a multi-byte code point split across `data` events, and a string
 * length cap counts UTF-16 units rather than the UTF-8 BYTES every caller
 * checks. Once the cap is reached the stream keeps DRAINING (the child is
 * never killed on overflow) so the child cannot block on a full pipe; only
 * retention stops. Exactly-at-cap is not truncated; one byte over is.
 */
function spawnCore(
  argv: readonly string[],
  opts: SpawnOptions,
  envMode: "merge" | "replace",
): Promise<SpawnResult> {
  const binary = argv[0];
  if (!binary || binary.includes("\u0000")) {
    return Promise.reject(new ValidationError("invalid executable path"));
  }
  // Resolve the guard from the SAME environment the child receives: a bare
  // `opts.env.GIT_DIR` lookup would miss an INHERITED `process.env.GIT_DIR` (or
  // `GIT_COMMON_DIR`) that the merge forwards to git, so the guard could inspect
  // a DIFFERENT repository than git reads and degrade the fail-closed refusal to
  // fail-open (native review R4-002). `"replace"` passes the caller's env
  // verbatim, so the guard and the child still read the same environment.
  const env = envMode === "replace" ? (opts.env ?? {}) : childEnvironment(opts.env);
  let args: readonly string[];
  try {
    // Host git is hardened at this single choke point for BOTH spawn paths, so
    // no future git caller can bypass it: repository-local hooks, fsmonitor and
    // pager are neutralized via `-c`, and an execution-bearing subcommand
    // carrying a repository-local exec key is refused before spawn.
    args = hardenGitArgv(argv, { cwd: opts.cwd, env }).slice(1);
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise<SpawnResult>((resolve) => {
    const child = spawn(binary, args, {
      shell: false,
      cwd: opts.cwd,
      env,
      stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const cap = opts.maxOutputBytes ?? 512 * 1024;
    // One byte-accurate sink per stream: retain up to `cap` BYTES, then keep
    // draining without retaining and remember that truncation happened.
    const sink = () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      return {
        push(chunk: Buffer): void {
          if (truncated) return;
          const remaining = cap - bytes;
          if (chunk.length <= remaining) {
            chunks.push(chunk);
            bytes += chunk.length;
            return;
          }
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          bytes = cap;
          truncated = true;
        },
        text(): string {
          return Buffer.concat(chunks).toString("utf8");
        },
        truncated(): boolean {
          return truncated;
        },
      };
    };
    const stdout = sink();
    const stderr = sink();
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    let spawnErrorText: string | null = null;
    if (opts.stdin && child.stdin) {
      // A child that exits without reading stdin fails the write with EPIPE.
      // That is expected for an early-exiting child: it must not crash the
      // broker or reject the spawn (the child's close status is authoritative).
      child.stdin.on("error", () => {
        /* tolerate EPIPE and every other stdin write failure */
      });
      child.stdin.end(opts.stdin);
    }
    let timedOut = false;
    let settled = false;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        stdout: stdout.text(),
        stderr: spawnErrorText ?? stderr.text(),
        timedOut,
        outputTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, opts.timeoutMs ?? 120_000);
    timer.unref();
    child.on("error", (err) => {
      spawnErrorText = `spawn error: ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * Worker-VM spawn path. Environment is `{ ...process.env, ...opts.env }`
 * (`childEnvironment`); five callers depend on inheriting `process.env`.
 */
export function spawnArgv(argv: readonly string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
  return spawnCore(argv, opts, "merge");
}

/**
 * Review-pipeline spawn entry point: identical byte-exact boundaries and the
 * same git-hardening choke point as {@link spawnArgv}, plus an explicit
 * `envMode`. Default `"merge"` keeps spawnArgv's semantics; `"replace"` is
 * OPT-IN and forwards only `opts.env`.
 */
export function spawnExec(argv: readonly string[], opts: SpawnExecOptions = {}): Promise<SpawnResult> {
  return spawnCore(argv, opts, opts.envMode ?? "merge");
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
    // Normalize CRLF -> LF (Gate 3 finding: msb exec's PTY path can emit \r\n;
    // --stream is environment-dependent — this normalization is not).
    return {
      ...result,
      stdout: normalizeLineEndings(result.stdout),
      stderr: normalizeLineEndings(result.stderr),
    };
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
    ];
    // Gate 5: a prepared worker root disk (git + 0777 /work) replaces the
    // --mkdir patch. msb WRITES the root-disk file during create (template
    // corruption observed — Gate 5 finding), so clone the template into the
    // per-worker config dir first; the template stays pristine.
    if (this.config.workerRootDisk) {
      const workerDisk = join(spec.configDir, "worker.ext4");
      mkdirSync(spec.configDir, { recursive: true });
      // Sparse copy (cp --sparse=always): copyFileSync materializes the full
      // 4G image INCLUDING holes (~4G real per worker -> EDQUOT, Gate 5
      // live finding). GNU cp preserves the sparsity.
      const copy = await spawnImpl(
        ["cp", "--sparse=always", this.config.workerRootDisk, workerDisk],
        { timeoutMs: 120_000 },
      );
      if (copy.status !== 0 && !copy.timedOut) {
        throw new MsbError(`worker disk copy failed (status ${copy.status}): ${trim(copy.stderr)}`);
      }
      args.push("--root-disk", `${workerDisk}:format=raw,fstype=ext4`);
    } else {
      args.push("--mkdir", "/work");
    }
    const res = await this.run(args, { timeoutMs: 180_000 });
    if (res.status !== 0 && !res.timedOut) {
      throw new MsbError(`msb create failed (status ${res.status}): ${trim(res.stderr || res.stdout)}`);
    }
    // Gate 5 finding: the guest agent comes up asynchronously after create;
    // copies/execs issued too early hit the still-booting ext4 (EBADMSG/EIO)
    // or a missing relay. Wait for agent readiness before returning.
    await this.waitReady(spec.name);
  }

  /** Poll `msb exec <name> -- true` until the guest agent answers (or timeout). */
  private async waitReady(workerName: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: SpawnResult | null = null;
    while (Date.now() < deadline) {
      last = await this.run(["exec", workerName, "-u", this.config.resource.workerUser, "--", "true"], {
        timeoutMs: 10_000,
      }).catch(() => null);
      if (last && last.status === 0) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new MsbError(
      `worker ${workerName} did not become ready within ${timeoutMs}ms (last status: ${last?.status ?? "n/a"})`,
    );
  }

  /** Run a command inside the worker. argv vector only. */
  async exec(
    workerName: string,
    argv: string[],
    opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; maxOutputBytes?: number } = {},
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
      maxOutputBytes: opts.maxOutputBytes,
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

  async removeConfigDir(workerName: string): Promise<void> {
    const dir = join(this.config.stateDir, "workers", workerName);
    rmSync(dir, { recursive: true, force: true });
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
