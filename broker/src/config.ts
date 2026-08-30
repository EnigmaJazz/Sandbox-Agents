/**
 * Broker policy — the TRUSTED configuration (SYSTEM_PROMPT.md §7, §21, §22).
 *
 * This file is part of the S17 protected set: agent execution must never
 * silently modify broker policy. Changes require manual review.
 *
 * Gate 1: values below are conservative DEFAULTS derived from the discovery
 * report. They are not authoritative until the manual gates pass (see
 * docs/manual-verification.md). No secrets live here.
 */
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const BROKER_VERSION = 1;

export interface ProjectConfig {
  id: string;
  /** Canonical path of the project root on the host. */
  path: string;
}

export interface ResourceConfig {
  /** Reserve at least this fraction of CPU for the host (§22). */
  reserveCpuFraction: number;
  /** Reserve at least this fraction of RAM for the host (§22). */
  reserveMemFraction: number;
  /** Never consume the final N bytes of host RAM (§22). */
  reserveMemBytes: number;
  /** Per-worker vCPU (§21: start 2, cap 4). */
  perWorkerCpu: number;
  /** Per-worker memory bytes (§21: start 2 GiB, cap 4 GiB). */
  perWorkerMemBytes: number;
  maxPerWorkerCpu: number;
  maxPerWorkerMemBytes: number;
  /** Aggregate pool caps (§22). */
  maxWorkers: number;
  maxAggregateCpu: number;
  maxAggregateMemBytes: number;
  /** Max B->C patch lines an apply may carry (approval preview limit). */
  maxApplyDiffLines: number;
  execTimeoutMsDefault: number;
  execTimeoutMsMax: number;
  contentMaxBytes: number;
  patchMaxBytes: number;
  outputMaxBytes: number;
  argvItemMaxBytes: number;
  argvMaxItems: number;
  argvTotalMaxBytes: number;
  pathMaxBytes: number;
  grepQueryMaxBytes: number;
  logLinesMax: number;
  /** Env keys allowed into worker exec (S8/S9: never credentials). */
  envAllowedKeys: string[];
  /** Guest user for worker commands (S11: non-root denies /dev/kvm — Gate 3). */
  workerUser: string;
}

export interface HostReadToolConfig {
  enabled: boolean;
  binary: string;
}

export interface HostReadConfig {
  systemSummary: HostReadToolConfig;
  memory: HostReadToolConfig;
  diskUsage: HostReadToolConfig;
  networkListeners: HostReadToolConfig;
  processList: HostReadToolConfig;
  serviceStatus: HostReadToolConfig;
  serviceLogs: HostReadToolConfig;
  tailscaleStatus: HostReadToolConfig;
  dockerList: HostReadToolConfig;
  dockerLogs: HostReadToolConfig;
}

export interface SddRuntimeConfig {
  /** Trusted host executable; never supplied by a request payload. */
  binary: string;
  outputMaxBytes: number;
}

export interface BrokerConfig {
  socketPath: string;
  stateDir: string;
  /** Optional JSONL log file; defaults to stdout (§26). */
  logPath?: string;
  msbBinary: string;
  /** Single trusted image; the LLM can never choose the image (§11, §21). */
  workerImage: string;
  /**
   * Optional prepared worker root disk (ext4 with git + 0777 /work, Gate 5).
   * When set, createWorker uses `--root-disk <disk>:format=raw,fstype=ext4`
   * instead of `--mkdir /work` (patches conflict with a managed root disk).
   */
  workerRootDisk?: string;
  workerNamePrefix: string;
  projects: ProjectConfig[];
  /** S6: explicit external read roots. Never grant whole-home access. */
  approvedExternalReadRoots: string[];
  /** Explicit absolute host FILE targets sandbox_copy_out/in may use (S15). */
  externalCopyTargets: string[];
  /** S7 + S17 protected paths (glob patterns, applied to canonical paths). */
  protectedPaths: string[];
  /** S17: security components agents must never modify. */
  protectedSecurityFiles: string[];
  /**
   * Idle reaper (Feature 1): sweep interval in ms. Every interval, workers
   * whose records are untouched for reapIdleMs are released.
   */
  reapIntervalMs: number;
  /**
   * Idle reaper (Feature 1): release a worker whose record has been untouched
   * for this long (ms). RESULT_READY keeps its state (result is host-side);
   * SANDBOX_ACTIVE closes as FAILED_CLOSED "idle reaped".
   */
  reapIdleMs: number;
  /**
   * Pool queue (Feature 2): how long a pool-exhausted ensureWorker parks for
   * a freed slot before failing with queued_timed_out (ms).
   */
  queueTimeoutMs: number;
  /**
   * Pool queue (Feature 2): maximum parked requests; beyond this, ensureWorker
   * fails immediately with "queue full" instead of parking unboundedly.
   */
  queueMaxLength: number;
  resource: ResourceConfig;
  hostRead: HostReadConfig;
  sddRuntime: SddRuntimeConfig;
  network: { mode: "deny-by-default"; note: string };
}

export type BrokerConfigOverrides = Omit<
  Partial<BrokerConfig>,
  "resource" | "sddRuntime"
> & {
  resource?: Partial<ResourceConfig>;
  sddRuntime?: Partial<SddRuntimeConfig>;
};

/** S7: sensitive host paths always denied to model/tool access. */
export const DEFAULT_PROTECTED_PATHS: string[] = [
  "**/.ssh/**",
  "**/.gnupg/**",
  "**/.aws/**",
  "**/.kube/**",
  "**/.config/gcloud/**",
  "**/.docker/**",
  "**/.local/share/opencode/auth.json",
  "**/.local/share/opencode/auth.json.*",
  "**/.config/gh/hosts.yml",
  "**/.git-credentials",
  "**/.netrc",
  "**/.env*",
  "**/.secret*/**",
  "**/.credential*/**",
  "**/*.key",
  "**/*.pem",
  "**/*.p12",
  "**/*.pfx",
];

/**
 * S17: paths inside this repository that define the security boundary itself.
 * A result that touches any of these is rejected at apply time without review.
 */
export const DEFAULT_PROTECTED_SECURITY_FILES: string[] = [
  "broker/src/**",
  "broker/package.json",
  "broker/tsconfig.json",
  "nono/profile/**",
  "opencode/plugins/**",
  "opencode/config-fragments/**",
  "systemd-user/**",
  "scripts/**",
  "tests/security/**",
  "tests/acceptance/**",
  "docs/threat-model.md",
];

/** Default project allowlist (id -> canonical path). Gate 1 placeholder. */
export const DEFAULT_PROJECTS: ProjectConfig[] = [
  // { id: "example", path: "/home/james/example" },
];

/** Default external read roots (S6). Gate 1 placeholder — never whole-home. */
export const DEFAULT_APPROVED_EXTERNAL_READ_ROOTS: string[] = [
  // "/home/james/reference",
];

/** Default external copy targets — empty; filled via BROKER_EXTERNAL_COPY_TARGETS. */
export const DEFAULT_EXTERNAL_COPY_TARGETS: string[] = [];

/** Fixed executables discovered on this host (discovery report §2, §5). */
export const DEFAULT_HOST_READ_CONFIG: HostReadConfig = {
  systemSummary: { enabled: true, binary: "/usr/bin/uname" },
  memory: { enabled: true, binary: "/usr/bin/free" },
  diskUsage: { enabled: true, binary: "/usr/bin/df" },
  networkListeners: { enabled: true, binary: "/usr/bin/ss" },
  processList: { enabled: true, binary: "/usr/bin/ps" },
  serviceStatus: { enabled: true, binary: "/usr/bin/systemctl" },
  serviceLogs: { enabled: true, binary: "/usr/bin/journalctl" },
  tailscaleStatus: { enabled: true, binary: "/usr/bin/tailscale" },
  dockerList: { enabled: false, binary: "/usr/bin/docker" },
  dockerLogs: { enabled: false, binary: "/usr/bin/docker" },
};

const GiB = 1024 * 1024 * 1024;

/**
 * Fail-closed env parsing for positive-integer knobs: an unset/empty var uses
 * the default; a present but invalid value aborts startup (never a silent
 * fallback to a different behavior than the operator asked for).
 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${name}: ${raw} (must be a positive integer)`);
  }
  return parsed;
}

export function defaultConfig(overrides: BrokerConfigOverrides = {}): BrokerConfig {
  const runtimeDir =
    process.env.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR.length > 0
      ? process.env.XDG_RUNTIME_DIR
      : tmpdir();
  const stateDir = resolve(
    process.env.BROKER_STATE_DIR ??
      join(homedir(), ".local", "state", "opencode-sandbox"),
  );
  const cfg: BrokerConfig = {
    socketPath: join(runtimeDir, "opencode-sandbox-broker.sock"),
    stateDir,
    logPath: process.env.BROKER_LOG_FILE,
    msbBinary: process.env.MSB_BINARY ?? "/home/james/.local/bin/msb",
    workerImage: process.env.MSB_WORKER_IMAGE ?? "debian",
    workerRootDisk: process.env.BROKER_WORKER_ROOT_DISK || undefined,
    workerNamePrefix: "oc-sandbox",
    projects: DEFAULT_PROJECTS,
    approvedExternalReadRoots: DEFAULT_APPROVED_EXTERNAL_READ_ROOTS,
    externalCopyTargets: DEFAULT_EXTERNAL_COPY_TARGETS,
    protectedPaths: DEFAULT_PROTECTED_PATHS,
    protectedSecurityFiles: DEFAULT_PROTECTED_SECURITY_FILES,
    reapIntervalMs: positiveIntEnv("BROKER_REAP_INTERVAL_MS", 60_000),
    reapIdleMs: positiveIntEnv("BROKER_REAP_IDLE_MS", 3_600_000),
    queueTimeoutMs: positiveIntEnv("BROKER_QUEUE_TIMEOUT_MS", 600_000),
    queueMaxLength: positiveIntEnv("BROKER_QUEUE_MAX_LENGTH", 32),
    resource: {
      reserveCpuFraction: 0.25,
      reserveMemFraction: 0.25,
      reserveMemBytes: 4 * GiB,
      perWorkerCpu: 2,
      perWorkerMemBytes: 2 * GiB,
      maxPerWorkerCpu: 4,
      maxPerWorkerMemBytes: 4 * GiB,
      maxWorkers: 4,
      maxAggregateCpu: 8,
      maxAggregateMemBytes: 8 * GiB,
      maxApplyDiffLines: 200,
      execTimeoutMsDefault: 120_000,
      execTimeoutMsMax: 600_000,
      contentMaxBytes: 1 * 1024 * 1024,
      patchMaxBytes: 4 * 1024 * 1024,
      outputMaxBytes: 512 * 1024,
      argvItemMaxBytes: 4 * 1024,
      argvMaxItems: 128,
      argvTotalMaxBytes: 64 * 1024,
      pathMaxBytes: 4 * 1024,
      grepQueryMaxBytes: 1024,
      logLinesMax: 500,
      envAllowedKeys: ["PATH", "HOME", "TERM", "LANG", "LC_ALL", "TMPDIR", "CI", "NO_COLOR", "GIT_*"],
      workerUser: "nobody",
    },
    hostRead: DEFAULT_HOST_READ_CONFIG,
    sddRuntime: {
      binary: process.env.BROKER_GENTLE_AI_BINARY ?? "gentle-ai",
      outputMaxBytes: 512 * 1024,
    },
    network: {
      mode: "deny-by-default",
      note: "Placeholder: final worker net config (S12) is generated at Gate 3 with allowlist domains only.",
    },
  };
  return {
    ...cfg,
    ...dropUndefined(overrides),
    resource: { ...cfg.resource, ...dropUndefined(overrides.resource) },
    sddRuntime: { ...cfg.sddRuntime, ...dropUndefined(overrides.sddRuntime) },
  };
}

/** Remove undefined keys so partial overrides never clobber defaults. */
function dropUndefined<T extends object>(obj: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (!obj) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
