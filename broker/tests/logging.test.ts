import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import type { WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { Logger } from "../src/logging.ts";
import { buildMetricsOp, type OpContext } from "../src/service.ts";
import { SessionStore } from "../src/state.ts";

async function closeLogger(logger: Logger, stream: WriteStream, root: string): Promise<void> {
  const closed = once(stream, "close");
  logger.close();
  await closed;
  rmSync(root, { recursive: true, force: true });
}

describe("Logger failure accounting", () => {
  test("counts a synchronous stream-write failure and emits one fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "logger-sync-failure-"));
    const logger = new Logger({ file: join(root, "broker.jsonl"), toConsole: false });
    const stream = (logger as unknown as { stream: WriteStream }).stream;
    await once(stream, "open");
    const originalStreamWrite = stream.write;
    const originalStderrWrite = process.stderr.write;
    const fallback: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => { fallback.push(chunk.toString()); return true; }) as typeof process.stderr.write;
    stream.write = (() => { throw new Error("stream unavailable"); }) as typeof stream.write;
    try {
      expect(() => logger.log({ operation: "metrics", result: "ok" })).not.toThrow();
      expect(logger.droppedLogLines).toBe(1);
      expect(fallback).toEqual(['{"event":"logger_sink_failure","error":"logging sink failed"}\n']);
      expect(fallback[0]).not.toContain('"operation":"metrics"');
    } finally {
      stream.write = originalStreamWrite;
      process.stderr.write = originalStderrWrite;
      await closeLogger(logger, stream, root);
    }
  });

  test("continues file logging after a synchronous stdout failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "logger-stdout-sync-failure-"));
    const file = join(root, "broker.jsonl");
    const logger = new Logger({ file });
    const stream = (logger as unknown as { stream: WriteStream }).stream;
    await once(stream, "open");
    const originalStdoutWrite = process.stdout.write;
    let calls = 0;
    process.stdout.write = (() => {
      calls += 1;
      if (calls === 1) throw new Error("stdout unavailable");
      return true;
    }) as typeof process.stdout.write;
    let closed = false;
    try {
      logger.log({ operation: "first", result: "ok" });
      logger.log({ operation: "second", result: "ok" });
      expect(logger.droppedLogLines).toBe(2);
      expect(calls).toBe(1);
      const streamClosed = once(stream, "close");
      logger.close();
      await streamClosed;
      closed = true;
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => JSON.parse(line).operation)).toEqual(["first", "second"]);
    } finally {
      process.stdout.write = originalStdoutWrite;
      if (!closed) await closeLogger(logger, stream, root);
      else rmSync(root, { recursive: true, force: true });
    }
  });

  test("latches asynchronous stdout errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "logger-stdout-async-failure-"));
    const file = join(root, "broker.jsonl");
    const logger = new Logger({ file });
    const stream = (logger as unknown as { stream: WriteStream }).stream;
    await once(stream, "open");
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const fallback: string[] = [];
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { fallback.push(chunk.toString()); return true; }) as typeof process.stderr.write;
    try {
      expect(() => process.stdout.emit("error", new Error("stdout unavailable"))).not.toThrow();
      expect(logger.droppedLogLines).toBe(1);
      expect((logger as unknown as { stdoutDead: boolean }).stdoutDead).toBe(true);
      expect(fallback).toContain('{"event":"logger_sink_failure","error":"logging sink failed"}\n');
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      await closeLogger(logger, stream, root);
    }
  });

  test("counts an asynchronous stream error and emits one fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "logger-async-failure-"));
    const logger = new Logger({ file: join(root, "broker.jsonl"), toConsole: false });
    const stream = (logger as unknown as { stream: WriteStream }).stream;
    await once(stream, "open");
    const originalStderrWrite = process.stderr.write;
    const fallback: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => { fallback.push(chunk.toString()); return true; }) as typeof process.stderr.write;
    try {
      expect(() => stream.emit("error", new Error("disk unavailable"))).not.toThrow();
      expect(logger.droppedLogLines).toBe(1);
      expect(fallback).toHaveLength(1);
    } finally {
      process.stderr.write = originalStderrWrite;
      await closeLogger(logger, stream, root);
    }
  });

  test("counts each later log after stream death without repeating the fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "logger-dead-stream-"));
    const logger = new Logger({ file: join(root, "broker.jsonl"), toConsole: false });
    const stream = (logger as unknown as { stream: WriteStream }).stream;
    await once(stream, "open");
    const originalStderrWrite = process.stderr.write;
    const fallback: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => { fallback.push(chunk.toString()); return true; }) as typeof process.stderr.write;
    try {
      stream.emit("error", new Error("disk unavailable"));
      logger.log({ operation: "metrics", result: "ok" });
      logger.log({ operation: "metrics", result: "ok" });
      expect(logger.droppedLogLines).toBe(3);
      expect(fallback).toHaveLength(1);
    } finally {
      process.stderr.write = originalStderrWrite;
      await closeLogger(logger, stream, root);
    }
  });

  test("returns the logger's current dropped-line count from metrics", async () => {
    const root = mkdtempSync(join(tmpdir(), "logger-metrics-"));
    const logger = { droppedLogLines: 7 };
    const context = {
      config: defaultConfig({ stateDir: root }),
      store: new SessionStore(root),
      pool: { allocations: [] },
      budget: {
        perWorkerCpu: 1, perWorkerMemBytes: 1, maxAggregateCpu: 10,
        maxAggregateMemBytes: 10, maxWorkers: 2, hostReservedCpu: 1,
        hostReservedMemBytes: 1,
      },
      resources: { cpuCount: 4, totalMemBytes: 100 },
      logger,
    } as unknown as OpContext;
    try {
      await expect(buildMetricsOp(context)({
        version: 1, id: "metrics-id", operation: "metrics", sessionID: "metrics-session",
      })).resolves.toMatchObject({ droppedLogLines: 7 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
