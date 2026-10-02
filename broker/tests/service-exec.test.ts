import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { buildExecOp, type OpContext } from "../src/service.ts";
import type { BrokerRequestEnvelope, SessionRecord } from "../src/types.ts";

const record = {
  sessionID: "session-1",
  state: "SANDBOX_ACTIVE",
  workerName: "worker-1",
  workerState: "ACTIVE",
} as SessionRecord;

async function execWithCwd(cwd: string): Promise<string | undefined> {
  let actualCwd: string | undefined;
  const ctx = {
    config: defaultConfig(),
    store: { get: () => record },
    adapter: {
      exec: async (_worker: string, _argv: string[], options: { cwd?: string }) => {
        actualCwd = options.cwd;
        return { status: 0, stdout: "", stderr: "", timedOut: false };
      },
    },
  } as unknown as OpContext;
  const request: BrokerRequestEnvelope = {
    version: 1,
    id: "request-1",
    operation: "exec",
    sessionID: record.sessionID,
    payload: { argv: ["true"], cwd },
  };

  await buildExecOp(ctx)(request);
  return actualCwd;
}

describe("buildExecOp cwd normalization", () => {
  test("translates a project-relative cwd to its guest-absolute path", async () => {
    expect(await execWithCwd("broker")).toBe("/work/broker");
  });

  test("translates nested project-relative cwd to its guest-absolute path", async () => {
    expect(await execWithCwd("docs/advisor")).toBe("/work/docs/advisor");
  });

  test("maps the project root cwd to /work", async () => {
    expect(await execWithCwd(".")).toBe("/work");
  });

  test("preserves the already-absolute internal /work cwd", async () => {
    expect(await execWithCwd("/work")).toBe("/work");
  });
});
