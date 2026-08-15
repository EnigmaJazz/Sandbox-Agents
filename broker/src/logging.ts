/**
 * JSONL structured logging (SYSTEM_PROMPT.md §26).
 *
 * Every broker operation logs: timestamp, sessionID, agent, projectID,
 * workerID, operation, result, duration, resource usage.
 *
 * NEVER logged: OAuth tokens, API keys, credential-shaped env vars, secret
 * file contents, or argv VALUES. Exec payloads are represented by their
 * argument COUNT only.
 */
import { createWriteStream, type WriteStream } from "node:fs";

export interface LogEntry {
  ts: string;
  sessionID?: string;
  agent?: string;
  projectID?: string;
  workerID?: string;
  operation: string;
  result: string;
  durationMs?: number;
  resources?: { cpu?: number; memBytes?: number };
  error?: string;
  argsCount?: number;
}

const SECRET_VALUE_RE =
  /(token|secret|password|credential|api[_-]?key|authorization)\s*[=:]\s*["']?[^\s"'&]+/gi;

/** Redact inline secret assignments from any free text we do log. */
export function redact(text: string): string {
  return text.replace(SECRET_VALUE_RE, (match, _key) => {
    const eq = match.includes("=") ? "=" : ":";
    const quote = match.includes('"') ? '"' : match.includes("'") ? "'" : "";
    return `${match.split(eq)[0]}${eq}${quote}REDACTED${quote}`;
  });
}

export class Logger {
  private readonly stream: WriteStream;
  private readonly toConsole: boolean;

  constructor(opts: { file?: string; toConsole?: boolean } = {}) {
    this.toConsole = opts.toConsole ?? true;
    this.stream = opts.file ? createWriteStream(opts.file, { flags: "a", mode: 0o600 }) : null as unknown as WriteStream;
  }

  log(entry: Omit<LogEntry, "ts">): void {
    const line = JSON.stringify({
      ...entry,
      error: entry.error ? redact(entry.error) : undefined,
      ts: new Date().toISOString(),
    });
    if (this.toConsole) {
      process.stdout.write(`${line}\n`);
    }
    if (this.stream) {
      this.stream.write(`${line}\n`);
    }
  }

  close(): void {
    if (this.stream) {
      this.stream.end();
    }
  }
}

export function durationMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

export function startTimer(): bigint {
  return process.hrtime.bigint();
}
