import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { buildReadFileOp, buildWriteFileOp, type OpContext } from "../src/service.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const roots: string[] = [];

function makeContext(record: SessionRecord, exec: (argv: string[]) => Promise<{ status: number; stdout: string; stderr: string; timedOut: boolean }>): OpContext {
  const stateDir = mkdtempSync(join(tmpdir(), "sandbox-edit-activation-"));
  roots.push(stateDir);
  return {
    config: defaultConfig({ stateDir, projects: [{ id: "repo", path: "/repo" }] }),
    store: { get: () => record },
    adapter: {
      exec: async (_worker: string, argv: string[]) => exec(argv),
      copyIn: async () => undefined,
    },
  } as unknown as OpContext;
}

function request(operation: "readFile" | "writeFile", payload: Record<string, unknown>): BrokerRequestEnvelope {
  return {
    version: 1,
    id: `req-${operation}`,
    operation,
    sessionID: "edit-activation-session",
    payload,
  } as BrokerRequestEnvelope;
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionID: "edit-activation-session",
    projectID: "repo",
    state: "SANDBOX_ACTIVE",
    workerName: "worker-edit-activation",
    workerState: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const sandboxTools = readFileSync(
  new URL("../../opencode/plugins/sandbox-tools.ts", import.meta.url),
  "utf8",
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("sandbox_edit ensures the worker before its first internal read", () => {
  const editStart = sandboxTools.indexOf('sandbox_edit: tool({');
  const editEnd = sandboxTools.indexOf('sandbox_apply_patch: tool({', editStart);
  const editTool = sandboxTools.slice(editStart, editEnd);

  expect(editTool.indexOf("await ensureWorker(ctx.sessionID, ctx.directory)")).toBeLessThan(
    editTool.indexOf('c.request("readFile"'),
  );
});

test("writeFile creates a missing target parent before moving the temporary file", async () => {
  const commands: string[][] = [];
  const directories = new Set(["/work/.broker-tmp"]);
  const ctx = makeContext(session(), async (argv) => {
    commands.push(argv);
    // The target does not exist yet.
    if (argv[0] === "stat" || argv[0] === "test") {
      return { status: 1, stdout: "", stderr: "No such file or directory", timedOut: false };
    }
    if (argv[0] === "mkdir" && argv[1] === "-p") directories.add(argv.at(-1)!);
    if (argv[0] === "mv" && !directories.has("nested")) {
      return { status: 1, stdout: "", stderr: "No such file or directory", timedOut: false };
    }
    return { status: 0, stdout: "", stderr: "", timedOut: false };
  });

  await buildWriteFileOp(ctx)(request("writeFile", { path: "nested/new-file.md", content: "contents" }));

  expect(commands).toContainEqual(["mkdir", "-p", "--", "nested"]);
  const mkdirAt = commands.findIndex((c) => c.join(" ") === "mkdir -p -- nested");
  const mvAt = commands.findIndex((c) => c[0] === "mv");
  expect(mvAt).toBeGreaterThan(mkdirAt);
  expect(commands.at(-1)?.[0]).toBe("rm");
});

test("readFile still refuses when the session has no active worker recorded", async () => {
  const ctx = makeContext(session({ workerName: undefined }), async () => {
    throw new Error("readFile must refuse before invoking the worker adapter");
  });

  await expect(buildReadFileOp(ctx)(request("readFile", { path: "README.md" }))).rejects.toThrow(
    "has no worker recorded — fail closed",
  );
});
