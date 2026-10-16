/**
 * Real-boundary tests for the host spawn surface (`spawnArgv` / `spawnExec`).
 *
 * Tier 4 items 56-58. Every case drives a REAL child process and asserts on the
 * bytes the kernel actually delivered across pipe `data` events. A fake spawn
 * that returns an already-decoded string cannot exercise a chunk boundary, a
 * byte cap, or an overflow flag — that is exactly the defect this suite exists
 * to catch, so no string-returning fake is used here.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnArgv, spawnExec } from "../src/msb.ts";
import { GitGuardError } from "../src/gitguard.ts";

const scriptDirs: string[] = [];

/** Materialize a CommonJS child program and return the argv that runs it. */
function childArgv(name: string, source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), `spawn-output-${name}-`));
  scriptDirs.push(dir);
  const file = join(dir, "child.cjs");
  writeFileSync(file, source);
  return [process.execPath, file];
}

afterAll(() => {
  for (const dir of scriptDirs) rmSync(dir, { recursive: true, force: true });
});

const FS = 'const fs = require("node:fs");';

describe("spawnArgv byte-exact output boundaries", () => {
  test("(a) a multi-byte code point split across data events decodes intact", async () => {
    // '€' is E2 82 AC, emitted as two syscalls so the parent observes two
    // `data` events with the code point split between them. Per-chunk decoding
    // yields U+FFFD; a single decode at EOF yields the code point.
    const argv = childArgv(
      "split",
      `${FS}\nfs.writeSync(1, Buffer.from([0xe2]));\nsetTimeout(() => { fs.writeSync(1, Buffer.from([0x82, 0xac])); }, 200);\n`,
    );
    const result = await spawnArgv(argv, { timeoutMs: 30_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("\u20ac");
    expect(result.stdout.includes("\uFFFD")).toBe(false);
  });

  test("(b) cap+1 bytes reports truncation and keeps exactly the cap", async () => {
    const cap = 5;
    const argv = childArgv("over", `${FS}\nfs.writeSync(1, Buffer.alloc(${cap + 1}, 0x61));\n`);
    const result = await spawnArgv(argv, { timeoutMs: 30_000, maxOutputBytes: cap });
    expect(Buffer.byteLength(result.stdout, "utf8")).toBe(cap);
    expect(result.stdout).toBe("a".repeat(cap));
    expect(result.outputTruncated).toBe(true);
  });

  test("(c) an output of exactly the cap is NOT reported truncated", async () => {
    const cap = 5;
    const argv = childArgv("exact", `${FS}\nfs.writeSync(1, Buffer.alloc(${cap}, 0x61));\n`);
    const result = await spawnArgv(argv, { timeoutMs: 30_000, maxOutputBytes: cap });
    expect(result.stdout).toBe("a".repeat(cap));
    expect(result.outputTruncated).toBe(false);
  });

  test("(d) stdin is delivered verbatim", async () => {
    const payload = Buffer.from("h\u00e9llo \u20ac\n", "utf8");
    const argv = childArgv(
      "stdin",
      'const chunks = [];\nprocess.stdin.on("data", (b) => chunks.push(b));\nprocess.stdin.on("end", () => process.stdout.write(Buffer.concat(chunks)));\n',
    );
    const result = await spawnArgv(argv, { timeoutMs: 30_000, stdin: payload });
    expect(result.status).toBe(0);
    expect(Buffer.from(result.stdout, "utf8").equals(payload)).toBe(true);
  });

  test("(e) stderr overflow sets stderrTruncated", async () => {
    const cap = 5;
    const argv = childArgv("stderr-over", `${FS}\nfs.writeSync(2, Buffer.alloc(${cap + 1}, 0x65));\n`);
    const result = await spawnArgv(argv, { timeoutMs: 30_000, maxOutputBytes: cap });
    expect(result.stderr).toBe("e".repeat(cap));
    expect(result.stderrTruncated).toBe(true);
  });
});

describe("spawnExec environment modes", () => {
  const PROBE = "SPAWN_EXEC_PROBE";

  async function withProbe<T>(value: string, body: () => Promise<T>): Promise<T> {
    const saved = process.env[PROBE];
    process.env[PROBE] = value;
    try {
      return await body();
    } finally {
      if (saved === undefined) delete process.env[PROBE];
      else process.env[PROBE] = saved;
    }
  }

  const echoProbe = childArgv("probe", `process.stdout.write(String(process.env.${PROBE}));`);

  test("merge (the default) inherits process.env", async () => {
    await withProbe("inherited", async () => {
      const result = await spawnExec(echoProbe, { timeoutMs: 30_000 });
      expect(result.stdout).toBe("inherited");
    });
  });

  test("merge lets opts.env override an inherited value", async () => {
    await withProbe("inherited", async () => {
      const result = await spawnExec(echoProbe, {
        timeoutMs: 30_000,
        env: { [PROBE]: "override" },
      });
      expect(result.stdout).toBe("override");
    });
  });

  test("replace mode forwards only opts.env", async () => {
    await withProbe("inherited", async () => {
      const result = await spawnExec(echoProbe, {
        timeoutMs: 30_000,
        envMode: "replace",
        env: { [PROBE]: "replaced" },
      });
      expect(result.stdout).toBe("replaced");
    });
  });

  test("replace mode inherits nothing when opts.env is absent", async () => {
    await withProbe("inherited", async () => {
      const result = await spawnExec(echoProbe, { timeoutMs: 30_000, envMode: "replace" });
      expect(result.stdout).toBe("undefined");
    });
  });

  test("spawnExec runs the shared git hardening choke point", async () => {
    await expect(
      spawnExec(["git", "-C", "/tmp", "status"], { envMode: "replace" }),
    ).rejects.toThrow(GitGuardError);
  });
});
