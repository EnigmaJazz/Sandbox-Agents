/**
 * Broker entry point.
 *
 * Usage:
 *   bun src/main.ts [--socket PATH] [--state-dir PATH] [--log-file PATH]
 *
 * Environment overrides: BROKER_SOCKET, BROKER_STATE_DIR, BROKER_LOG_FILE,
 * BROKER_GIT_MODE (real|planned), MSB_BINARY, MSB_WORKER_IMAGE.
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
