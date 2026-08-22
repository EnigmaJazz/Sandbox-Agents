/*
 * Broker entry point.
 *
 * Usage:
 *   bun src/main.ts [--socket PATH] [--state-dir PATH] [--log-file PATH]
 *
 * Environment overrides: BROKER_SOCKET, BROKER_STATE_DIR, BROKER_LOG_FILE,
 * BROKER_GIT_MODE (real|planned), MSB_BINARY, MSB_WORKER_IMAGE,
 * BROKER_GENTLE_AI_BINARY.
 *
 * Gate 1: nothing is installed; run manually for local testing only.
 * The systemd unit (systemd-user/sandbox-broker.service) is the intended
 * production launcher after Gate 4 manual review.
 */
import { defaultConfig } from "./config.ts";
import { BrokerServer } from "./server.ts";

interface CliArgs {
  socket?: string;
  stateDir?: string;
  logFile?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--socket") {
      out.socket = argv[++i];
    } else if (arg === "--state-dir") {
      out.stateDir = argv[++i];
    } else if (arg === "--log-file") {
      out.logFile = argv[++i];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function usage(): string {
  return [
    "sandbox-broker — trusted OpenCode sandbox broker",
    "",
    "Usage: bun src/main.ts [options]",
    "  --socket PATH     Unix socket path (default: $XDG_RUNTIME_DIR/opencode-sandbox-broker.sock)",
    "  --state-dir PATH  State directory (default: ~/.local/state/opencode-sandbox)",
    "  --log-file PATH   JSONL log file (default: stdout)",
    "  -h, --help        Show this help",
    "",
    "NOT installed at Gate 1. See docs/manual-verification.md for the gates.",
  ].join("\n");
}

/**
 * Env-driven policy overrides: BROKER_PROJECTS (JSON array of {id, path}),
 * BROKER_EXTERNAL_ROOTS (JSON array of approved read-only paths, S6),
 * BROKER_EXTERNAL_COPY_TARGETS (JSON array of approved copy file targets, S15)
 * and BROKER_WORKER_ROOT_DISK. Projects/roots/targets/binaries come from
 * trusted configuration — never from request payloads (§7).
 */
function parseBrokerEnv(): {
  projects?: { id: string; path: string }[];
  approvedExternalReadRoots?: string[];
  protectedSecurityFiles?: string[];
  resource?: { maxApplyDiffLines?: number };
  externalCopyTargets?: string[];
  sddRuntime?: { binary: string };
} {
  const raw = process.env.BROKER_PROJECTS;
  const out: {
    projects?: { id: string; path: string }[];
    approvedExternalReadRoots?: string[];
    protectedSecurityFiles?: string[];
    resource?: { maxApplyDiffLines?: number };
    externalCopyTargets?: string[];
    sddRuntime?: { binary: string };
  } = {};
  const gentleAiBinary = process.env.BROKER_GENTLE_AI_BINARY;
  if (gentleAiBinary !== undefined) {
    if (gentleAiBinary.length === 0 || gentleAiBinary.includes("\u0000")) {
      console.error("invalid BROKER_GENTLE_AI_BINARY: must be a non-empty executable name or path");
      process.exit(1);
    }
    out.sddRuntime = { binary: gentleAiBinary };
  }
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) throw new Error("BROKER_PROJECTS must be a JSON array");
      out.projects = parsed.map((p, i) => {
        const o = p as { id?: unknown; path?: unknown };
        if (typeof o?.id !== "string" || typeof o?.path !== "string") {
          throw new Error(`BROKER_PROJECTS[${i}] must have string id and path`);
        }
        return { id: o.id, path: o.path };
      });
    } catch (err) {
      console.error(`invalid BROKER_PROJECTS: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  const roots = process.env.BROKER_EXTERNAL_ROOTS;
  if (roots) {
    try {
      const parsed = JSON.parse(roots) as unknown;
      if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== "string")) {
        throw new Error("BROKER_EXTERNAL_ROOTS must be a JSON array of strings");
      }
      out.approvedExternalReadRoots = parsed as string[];
    } catch (err) {
      console.error(`invalid BROKER_EXTERNAL_ROOTS: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  const protectedFiles = process.env.BROKER_PROTECTED_SECURITY_FILES;
  if (protectedFiles) {
    try {
      const parsed = JSON.parse(protectedFiles) as unknown;
      if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== "string")) {
        throw new Error("BROKER_PROTECTED_SECURITY_FILES must be a JSON array of strings");
      }
      out.protectedSecurityFiles = parsed as string[];
    } catch (err) {
      console.error(`invalid BROKER_PROTECTED_SECURITY_FILES: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  const maxApplyDiffLines = process.env.BROKER_MAX_APPLY_DIFF_LINES;
  if (maxApplyDiffLines !== undefined && maxApplyDiffLines !== "") {
    const parsed = Number(maxApplyDiffLines);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error(`invalid BROKER_MAX_APPLY_DIFF_LINES: ${maxApplyDiffLines}`);
      process.exit(1);
    }
    out.resource = { maxApplyDiffLines: parsed };
  }
  const copyTargets = process.env.BROKER_EXTERNAL_COPY_TARGETS;
  if (copyTargets) {
    try {
      const parsed = JSON.parse(copyTargets) as unknown;
      if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== "string")) {
        throw new Error("BROKER_EXTERNAL_COPY_TARGETS must be a JSON array of strings");
      }
      out.externalCopyTargets = parsed as string[];
    } catch (err) {
      console.error(`invalid BROKER_EXTERNAL_COPY_TARGETS: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  const config = defaultConfig({
    socketPath: args.socket ?? process.env.BROKER_SOCKET,
    stateDir: args.stateDir ?? process.env.BROKER_STATE_DIR,
    logPath: args.logFile ?? process.env.BROKER_LOG_FILE,
    ...parseBrokerEnv(),
  });
  const server = new BrokerServer(config);
  const shutdown = () => {
    server.shutdown?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.start();
  console.error(`sandbox broker listening on ${config.socketPath} (state: ${config.stateDir})`);
}

await main();
