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
  detail?: string;
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
  private static readonly stdoutLoggers = new Set<Logger>();
  private static readonly handleStdoutError = (): void => {
    for (const logger of Logger.stdoutLoggers) logger.handleStdoutError();
  };

  private readonly file: string | undefined;
  private readonly stream: WriteStream;
  private readonly toConsole: boolean;
  // Reopening a dead sink requires a broker restart; no retry path is implemented.
  private streamDead = false;
  private stdoutDead = false;
  private fallbackWritten = false;
  private droppedLogLineCount = 0;
  private readonly handleStreamError = (): void => {
    if (this.streamDead) return;
    this.streamDead = true;
    this.markDropped();
  };
  private readonly handleStdoutError = (): void => {
    if (this.stdoutDead) return;
    this.stdoutDead = true;
    this.markDropped();
  };

  constructor(opts: { file?: string; toConsole?: boolean } = {}) {
    this.file = opts.file;
    this.toConsole = opts.toConsole ?? true;
    this.stream = this.file ? createWriteStream(this.file, { flags: "a", mode: 0o600 }) : null as unknown as WriteStream;
    if (this.stream) this.stream.on("error", this.handleStreamError);
    if (this.toConsole) {
      Logger.stdoutLoggers.add(this);
      if (Logger.stdoutLoggers.size === 1) process.stdout.on("error", Logger.handleStdoutError);
    }
  }

  get droppedLogLines(): number {
    return this.droppedLogLineCount;
  }

  log(entry: Omit<LogEntry, "ts">): void {
    let line: string;
    try {
      line = JSON.stringify({
        ...entry,
        error: entry.error ? redact(entry.error) : undefined,
        ts: new Date().toISOString(),
      });
    } catch {
      this.markDropped();
      return;
    }

    let dropped = false;
    const markLineDropped = (): void => {
      if (dropped) return;
      dropped = true;
      this.markDropped();
    };

    if (this.stream) {
      if (this.streamDead) markLineDropped();
      else {
        try {
          this.stream.write(`${line}\n`);
        } catch {
          this.streamDead = true;
          markLineDropped();
        }
      }
    }

    if (this.toConsole) {
      if (this.stdoutDead) markLineDropped();
      else {
        try {
          process.stdout.write(`${line}\n`);
        } catch {
          this.stdoutDead = true;
          markLineDropped();
        }
      }
    }
  }

  private markDropped(): void {
    this.droppedLogLineCount += 1;
    this.writeFallback();
  }

  private writeFallback(): void {
    if (this.fallbackWritten) return;
    this.fallbackWritten = true;
    try {
      const encode = (value: string): string => {
        try {
          return JSON.stringify(redact(value)) ?? '"[unavailable]"';
        } catch {
          return '"[unavailable]"';
        }
      };
      const record = `{${`"event":${encode("logger_sink_failure")}`},${`"error":${encode("logging sink failed")}`}}`;
      process.stderr.write(`${record}\n`);
    } catch {
      // The emergency path must never throw or recurse into logging.
    }
  }

  close(): void {
    if (this.toConsole) {
      Logger.stdoutLoggers.delete(this);
      if (Logger.stdoutLoggers.size === 0) process.stdout.off("error", Logger.handleStdoutError);
    }
    if (this.stream) {
      this.stream.once("close", () => this.stream.off("error", this.handleStreamError));
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
