/**
 * readFile / writeFile byte and mode integrity (TODO Tier 1 items 2 and 3).
 *
 * A small in-memory worker filesystem stands in for the microVM so the tests
 * assert outcomes (bytes, modes, owners, leftovers), not just argv shapes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { MsbAdapter, getSpawnImpl, setSpawnImpl } from "../src/msb.ts";
import { buildEnsureWorkerOp, buildReadFileOp, buildWriteFileOp, type OpContext } from "../src/service.ts";
import { SessionStore } from "../src/state.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

type Owner = "root" | "worker";
interface Node {
  kind: "file" | "dir";
  bytes: Buffer;
  mode: string;
  owner: Owner;
}
interface Result {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const ok = (stdout = ""): Result => ({ status: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr: string, status = 1): Result => ({ status, stdout: "", stderr, timedOut: false });

/** Minimal model of the worker: paths relative to /work, worker user is non-root. */
class FakeWorker {
  readonly fs = new Map<string, Node>();
  readonly commands: string[][] = [];
  /** Optional per-command override, e.g. to simulate a truncated read. */
  override?: (argv: string[]) => Result | undefined;

  constructor() {
    this.fs.set("/work", { kind: "dir", bytes: Buffer.alloc(0), mode: "755", owner: "worker" });
  }

  abs(p: string): string {
    return p.startsWith("/") ? p : `/work/${p}`;
  }

  file(p: string, content: string | Buffer, mode = "644", owner: Owner = "worker"): void {
    this.fs.set(this.abs(p), {
      kind: "file",
      bytes: Buffer.isBuffer(content) ? content : Buffer.from(content),
      mode,
      owner,
    });
  }

  get(p: string): Node | undefined {
    return this.fs.get(this.abs(p));
  }

  exec(argv: string[]): Result {
    this.commands.push(argv);
    const forced = this.override?.(argv);
    if (forced) return forced;
    const [cmd, ...rest] = argv;
    const args = rest.filter((a) => a !== "--");
    switch (cmd) {
      case "stat": {
        const fmt = args[args.indexOf("-c") + 1]!;
        const node = this.get(args.at(-1)!);
        if (!node) return fail(`stat: cannot statx '${args.at(-1)}': No such file or directory`);
        const type = node.kind === "dir" ? "directory" : node.bytes.length === 0 ? "regular empty file" : "regular file";
        return ok(`${fmt.replace("%s", String(node.bytes.length)).replace("%a", node.mode).replace("%F", type)}\n`);
      }
      case "base64": {
        const node = this.get(args.at(-1)!);
        if (!node) return fail("base64: No such file or directory");
        return ok(node.bytes.toString("base64"));
      }
      case "test":
        return this.get(args.at(-1)!) ? ok() : fail("", 1);
      case "mkdir": {
        const dir = this.abs(args.at(-1)!);
        if (!this.fs.has(dir)) this.fs.set(dir, { kind: "dir", bytes: Buffer.alloc(0), mode: "755", owner: "worker" });
        return ok();
      }
      case "cp": {
        const [src, dst] = args.slice(-2) as [string, string];
        const node = this.get(src);
        if (!node) return fail("cp: No such file or directory");
        // cp without -p creates a new file owned by the caller.
        this.fs.set(this.abs(dst), { kind: "file", bytes: Buffer.from(node.bytes), mode: node.mode, owner: "worker" });
        return ok();
      }
      case "chmod": {
        const [mode, target] = args.slice(-2) as [string, string];
        const node = this.get(target);
        if (!node) return fail("chmod: No such file or directory");
        if (node.owner !== "worker") return fail(`chmod: changing permissions of '${target}': Operation not permitted`);
        node.mode = mode;
        return ok();
      }
      case "mv": {
        const [src, dst] = args.slice(-2) as [string, string];
        const node = this.get(src);
        if (!node) return fail("mv: No such file or directory");
        this.fs.delete(this.abs(src));
        this.fs.set(this.abs(dst), node);
        return ok();
      }
      case "rm":
        for (const p of args.filter((a) => !a.startsWith("-"))) this.fs.delete(this.abs(p));
        return ok();
      default:
        return fail(`unexpected command ${cmd}`, 127);
    }
  }

  /** msb copy: the guest file is root-owned and keeps the host mode (0644). */
  copyIn(hostSrc: string, dest: string): void {
    this.file(dest, readFileSync(hostSrc), "644", "root");
  }

  leftovers(): string[] {
    return [...this.fs.keys()].filter((p) => /\.broker-write-|\/\.broker-tmp\/write-/.test(p));
  }
}

const roots: string[] = [];

function makeContext(worker: FakeWorker): OpContext {
  const stateDir = mkdtempSync(join(tmpdir(), "sandbox-file-integrity-"));
  roots.push(stateDir);
  return {
    config: defaultConfig({ stateDir, projects: [{ id: "repo", path: "/repo" }] }),
    store: { get: () => session() },
    adapter: {
      exec: async (_w: string, argv: string[]) => worker.exec(argv),
      copyIn: async (_w: string, src: string, dest: string) => worker.copyIn(src, dest),
    },
  } as unknown as OpContext;
}

function session(): SessionRecord {
  return {
    sessionID: "integrity-session",
    projectID: "repo",
    state: "SANDBOX_ACTIVE",
    workerName: "worker-integrity",
    workerState: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function request(operation: "readFile" | "writeFile", payload: Record<string, unknown>): BrokerRequestEnvelope {
  return { version: 1, id: `req-${operation}`, operation, sessionID: "integrity-session", payload } as BrokerRequestEnvelope;
}

const read = (worker: FakeWorker, path: string) =>
  buildReadFileOp(makeContext(worker))(request("readFile", { path })) as Promise<{ content: string }>;
const write = (worker: FakeWorker, path: string, content: string) =>
  buildWriteFileOp(makeContext(worker))(request("writeFile", { path, content }));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readFile returns the exact bytes or refuses", () => {
  test("CRLF line endings and a BOM survive unchanged", async () => {
    const worker = new FakeWorker();
    worker.file("win.txt", "﻿line one\r\nline two\r\n");
    const { content } = await read(worker, "win.txt");
    expect(content).toBe("﻿line one\r\nline two\r\n");
  });

  test("a file larger than the old 512 KB output cap is returned whole", async () => {
    const worker = new FakeWorker();
    const big = `${"x".repeat(79)}\n`.repeat(9_000); // 720,000 bytes
    worker.file("big.sh", big, "755");
    const { content } = await read(worker, "big.sh");
    expect(content.length).toBe(big.length);
    expect(content).toBe(big);
  });

  test("a truncated read is refused instead of returning partial content", async () => {
    const worker = new FakeWorker();
    worker.file("script.sh", "a".repeat(10_000));
    worker.override = (argv) =>
      argv[0] === "base64" ? ok(Buffer.from("a".repeat(4_000)).toString("base64")) : undefined;
    await expect(read(worker, "script.sh")).rejects.toThrow("read 4000 of 10000 bytes");
  });

  test("a file over the write limit is refused before any content is read", async () => {
    const worker = new FakeWorker();
    worker.file("huge.bin", Buffer.alloc(2 * 1024 * 1024, 0x61));
    await expect(read(worker, "huge.bin")).rejects.toThrow("over the 1048576-byte limit");
    expect(worker.commands.some((c) => c[0] === "base64")).toBe(false);
  });

  test("non-UTF-8 content is refused rather than mangled", async () => {
    const worker = new FakeWorker();
    worker.file("blob.bin", Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    await expect(read(worker, "blob.bin")).rejects.toThrow("not valid UTF-8");
  });

  test("a directory is refused", async () => {
    const worker = new FakeWorker();
    worker.exec(["mkdir", "-p", "--", "docs"]);
    worker.commands.length = 0;
    await expect(read(worker, "docs")).rejects.toThrow("not a regular file");
  });

  test("an empty file reads as empty", async () => {
    const worker = new FakeWorker();
    worker.file("empty.txt", "");
    expect((await read(worker, "empty.txt")).content).toBe("");
  });
});

describe("writeFile keeps the target's mode and leaves it worker-owned", () => {
  test("an executable script stays 755 after an edit", async () => {
    const worker = new FakeWorker();
    worker.file("verify-workflow.sh", "#!/usr/bin/env bash\necho old\n", "755");
    await write(worker, "verify-workflow.sh", "#!/usr/bin/env bash\necho new\n");
    const node = worker.get("verify-workflow.sh")!;
    expect(node.bytes.toString()).toBe("#!/usr/bin/env bash\necho new\n");
    expect(node.mode).toBe("755");
    expect(node.owner).toBe("worker");
  });

  test("a restrictive mode is preserved too", async () => {
    const worker = new FakeWorker();
    worker.file("secret.conf", "a=1\n", "600");
    await write(worker, "secret.conf", "a=2\n");
    expect(worker.get("secret.conf")!.mode).toBe("600");
  });

  test("a previously root-owned target becomes worker-owned and keeps its mode", async () => {
    const worker = new FakeWorker();
    worker.file("tool.sh", "old\n", "755", "root");
    await write(worker, "tool.sh", "new\n");
    expect(worker.get("tool.sh")).toMatchObject({ mode: "755", owner: "worker" });
  });

  test("a new file is created 644, worker-owned, in a created parent", async () => {
    const worker = new FakeWorker();
    await write(worker, "nested/new-file.md", "contents");
    const node = worker.get("nested/new-file.md")!;
    expect(node.bytes.toString()).toBe("contents\n");
    expect(node).toMatchObject({ mode: "644", owner: "worker" });
  });

  test("no temporary files are left behind", async () => {
    const worker = new FakeWorker();
    worker.file("a.txt", "1\n");
    await write(worker, "a.txt", "2\n");
    expect(worker.leftovers()).toEqual([]);
  });

  test("a failed replace leaves the original intact and cleans up its temps", async () => {
    const worker = new FakeWorker();
    worker.file("keep.sh", "original\n", "755");
    worker.override = (argv) => (argv[0] === "mv" ? fail("mv: disk full") : undefined);
    await expect(write(worker, "keep.sh", "replacement\n")).rejects.toThrow("mv: disk full");
    expect(worker.get("keep.sh")).toMatchObject({ mode: "755" });
    expect(worker.get("keep.sh")!.bytes.toString()).toBe("original\n");
    expect(worker.leftovers()).toEqual([]);
  });

  test("a directory target is refused before anything is copied in", async () => {
    const worker = new FakeWorker();
    worker.exec(["mkdir", "-p", "--", "docs"]);
    await expect(write(worker, "docs", "x")).rejects.toThrow("not a regular file");
    expect(worker.commands.some((c) => c[0] === "cp" || c[0] === "mv")).toBe(false);
  });

  test("an existing target whose mode cannot be read fails closed", async () => {
    const worker = new FakeWorker();
    worker.file("odd.txt", "x\n", "644");
    worker.override = (argv) => (argv[0] === "stat" ? fail("stat: Permission denied") : undefined);
    await expect(write(worker, "odd.txt", "y\n")).rejects.toThrow("could not read the existing mode");
    expect(worker.get("odd.txt")!.bytes.toString()).toBe("x\n");
  });

  test("an edit round trip through readFile and writeFile keeps bytes and mode", async () => {
    const worker = new FakeWorker();
    const original = `#!/usr/bin/env bash\r\n${"echo line\r\n".repeat(30_000)}`; // ~330 KB, CRLF
    worker.file("big.sh", original, "755");
    const { content } = await read(worker, "big.sh");
    const edited = content.replace("echo line\r\n", "echo first\r\n");
    await write(worker, "big.sh", edited);
    const node = worker.get("big.sh")!;
    expect(node.bytes.toString()).toBe(edited);
    expect(node.mode).toBe("755");
  });
});

describe("ensureWorker snapshot pinning", () => {
  function git(repo: string, ...args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "snapshot-pinning-"));
    roots.push(dir);
    git(dir, "init", "-q");
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "user.email", "test@example.invalid");
    Bun.write(join(dir, "file.txt"), "base\\n");
    git(dir, "add", "file.txt");
    git(dir, "commit", "-qm", "base");
    return dir;
  }

  function ensureContext(dir: string) {
    const stateDir = mkdtempSync(join(tmpdir(), "snapshot-state-"));
    roots.push(stateDir);
    const store = new SessionStore(stateDir);
    const created: string[] = [];
    const ctx = {
      config: defaultConfig({ stateDir, projects: [{ id: "repo", path: dir }] }),
      store,
      adapter: {
        workerNameFor: (id: string) => `worker-${id}`,
        createWorker: async ({ name }: { name: string }) => { created.push(name); },
        copyIn: async () => undefined,
        exec: async () => ok(),
        stop: async () => undefined,
        remove: async () => undefined,
      },
      budget: { perWorkerCpu: 2, perWorkerMemBytes: 2 * 1024 ** 3, maxAggregateCpu: 8, maxAggregateMemBytes: 8 * 1024 ** 3, maxWorkers: 4 },
      resources: { cpuCount: 16, totalMemBytes: 32 * 1024 ** 3 },
      pool: { allocations: [] },
      hostRead: { has: () => false, execute: async () => ({}) },
      logger: {},
      git: {
        runnerMode: "real" as const,
        spawn: async (argv: string[], opts?: { cwd?: string; env?: Record<string, string> }) => {
          const result = Bun.spawnSync(argv, { cwd: opts?.cwd ?? dir, env: { ...process.env, ...opts?.env } });
          return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), timedOut: false };
        },
      },
    } as unknown as OpContext;
    const ensure = (sessionID: string, snapshot?: Record<string, unknown>) =>
      buildEnsureWorkerOp(ctx)({ version: 1, id: `req-${sessionID}`, operation: "ensureWorker", sessionID, agent: "test", payload: { projectDir: dir, ...(snapshot ? { snapshot } : {}) } } as BrokerRequestEnvelope);
    return { ensure, created };
  }

  test("refuses HEAD~1, arbitrary and another project's result refs, and a short SHA", async () => {
    const dir = repo();
    const other = repo();
    git(other, "update-ref", "refs/opencode-sandbox/result/other", git(other, "rev-parse", "HEAD"));
    const { ensure } = ensureContext(dir);
    for (const snapshot of [{ resultRef: "HEAD~1" }, { resultRef: "refs/heads/unrelated" }, { resultRef: "refs/opencode-sandbox/result/other" }, { commit: "deadbeef" }]) {
      await expect(ensure(`refused-${JSON.stringify(snapshot)}`, snapshot)).rejects.toThrow();
    }
  });

  test("pins the resolved result commit even after its ref moves", async () => {
    const dir = repo();
    const first = git(dir, "rev-parse", "HEAD");
    git(dir, "update-ref", "refs/opencode-sandbox/result/pinned", first);
    const { ensure } = ensureContext(dir);
    const result = await ensure("pinned", { resultRef: "refs/opencode-sandbox/result/pinned" }) as { snapshot: { commit: string; tree: string; source: string; resultRef: string; headSha: string } };
    Bun.write(join(dir, "file.txt"), "moved\\n");
    git(dir, "commit", "-qam", "move ref");
    git(dir, "update-ref", "refs/opencode-sandbox/result/pinned", git(dir, "rev-parse", "HEAD"));
    expect(result.snapshot).toMatchObject({ commit: first, tree: git(dir, "rev-parse", `${first}^{tree}`), source: "resultRef", resultRef: "refs/opencode-sandbox/result/pinned" });
  });

  test("uncommitted working-tree changes produce a distinct snapshot commit", async () => {
    const dir = repo();
    const head = git(dir, "rev-parse", "HEAD");
    Bun.write(join(dir, "file.txt"), "uncommitted\\n");
    const { ensure } = ensureContext(dir);
    const result = await ensure("worktree") as { snapshot: { commit: string; tree: string; source: string; headSha: string } };
    expect(result.snapshot).toMatchObject({ source: "worktree", headSha: head });
    expect(result.snapshot.commit).not.toBe(head);
    expect(result.snapshot.tree).not.toBe(git(dir, "rev-parse", `${head}^{tree}`));
  });

  test("refuses a different snapshot for an existing worker", async () => {
    const dir = repo();
    const first = git(dir, "rev-parse", "HEAD");
    Bun.write(join(dir, "file.txt"), "next\\n");
    git(dir, "commit", "-qam", "next");
    const second = git(dir, "rev-parse", "HEAD");
    const { ensure, created } = ensureContext(dir);
    await ensure("same-session", { commit: first });
    await expect(ensure("same-session", { commit: second })).rejects.toThrow(/snapshot/i);
    expect(created).toHaveLength(1);

    const worktreeHarness = ensureContext(dir);
    await worktreeHarness.ensure("worktree-session");
    await expect(worktreeHarness.ensure("worktree-session")).resolves.toMatchObject({ reused: true });
    Bun.write(join(dir, "file.txt"), "changed after worker creation\\n");
    await expect(worktreeHarness.ensure("worktree-session")).rejects.toThrow(/snapshot/i);
    expect(worktreeHarness.created).toHaveLength(1);
  });
});

describe("MsbAdapter.exec output limit", () => {
  test("a per-call maxOutputBytes reaches the spawn", async () => {
    const previous = getSpawnImpl();
    const seen: Array<number | undefined> = [];
    setSpawnImpl(async (_argv, opts) => {
      seen.push(opts.maxOutputBytes);
      return { status: 0, stdout: "", stderr: "", timedOut: false };
    });
    try {
      const adapter = new MsbAdapter(defaultConfig());
      await adapter.exec("w1", ["true"], { maxOutputBytes: 1_398_168 });
      await adapter.exec("w1", ["true"]);
      expect(seen[0]).toBe(1_398_168);
      expect(seen[1]).toBe(defaultConfig().resource.outputMaxBytes);
    } finally {
      setSpawnImpl(previous);
    }
  });
});
