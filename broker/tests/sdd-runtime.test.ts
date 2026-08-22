import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { SpawnFn } from "../src/msb.ts";
import { ValidationError } from "../src/validation.ts";
import {
  SddRuntimeExecutor,
  buildSddAttemptAcquireArgv,
  buildSddStatusArgv,
} from "../src/sdd-runtime.ts";

const projectRoot = realpathSync(resolve(import.meta.dir, "../.."));
const configuredProjectRoot = `${projectRoot}/broker/..`;

const acquireInput = {
  binary: "gentle-ai",
  projectRoot: "/home/james/peak-redir",
  change: "peak-hour-routing",
  requestId: "sandbox-diagnosis",
  workUnit: "slice-1-proof-policy",
  evidenceGoal: "proof-policy-implementation",
  maxAttempts: 1,
  maxChangedLines: 300,
};

function makeExecutor(spawn: SpawnFn): SddRuntimeExecutor {
  return new SddRuntimeExecutor({
    binary: "gentle-ai",
    projects: [{ id: "repo", path: configuredProjectRoot }],
    spawn,
  });
}

describe("host-side SDD runtime argv", () => {
  test("builds the exact status argv for a configured project root", () => {
    expect(
      buildSddStatusArgv({ binary: "gentle-ai", projectRoot }),
    ).toEqual([
      "gentle-ai",
      "sdd-status",
      "--cwd",
      projectRoot,
      "--json",
      "--instructions",
    ]);
  });

  test("builds the exact attempt-acquire argv", () => {
    expect(buildSddAttemptAcquireArgv(acquireInput)).toEqual([
      "gentle-ai",
      "sdd-attempt",
      "acquire",
      "--cwd",
      "/home/james/peak-redir",
      "--change",
      "peak-hour-routing",
      "--request-id",
      "sandbox-diagnosis",
      "--work-unit",
      "slice-1-proof-policy",
      "--evidence-goal",
      "proof-policy-implementation",
      "--max-attempts",
      "1",
      "--max-changed-lines",
      "300",
    ]);
  });
});

describe("host-side SDD runtime executor", () => {
  test("resolves only an exact configured project root", () => {
    const spawn: SpawnFn = async () => ({
      status: 0,
      stdout: "{}",
      stderr: "",
      timedOut: false,
    });
    const executor = makeExecutor(spawn);

    expect(executor.resolveProjectRoot(configuredProjectRoot)).toBe(projectRoot);
    expect(() => executor.resolveProjectRoot("/etc")).toThrow(ValidationError);
  });

  test("passes exact argv and canonical cwd, parsing JSON despite a nonzero exit", async () => {
    const calls: Array<{ argv: string[]; cwd: string | undefined }> = [];
    const spawn: SpawnFn = async (argv, options) => {
      calls.push({ argv: [...argv], cwd: options.cwd });
      return {
        status: 17,
        stdout: JSON.stringify({ state: "blocked", reason: "attempt-held" }),
        stderr: "attempt already held",
        timedOut: false,
      };
    };
    const executor = makeExecutor(spawn);

    const result = await executor.status(configuredProjectRoot);

    expect(calls).toEqual([
      {
        argv: [
          "gentle-ai",
          "sdd-status",
          "--cwd",
          projectRoot,
          "--json",
          "--instructions",
        ],
        cwd: projectRoot,
      },
    ]);
    expect(result).toEqual({
      status: 17,
      json: { state: "blocked", reason: "attempt-held" },
      stderr: "attempt already held",
    });
  });

  test("rejects non-JSON stdout instead of returning an unstructured result", async () => {
    const spawn: SpawnFn = async () => ({
      status: 1,
      stdout: "not JSON",
      stderr: "command failed",
      timedOut: false,
    });
    const executor = makeExecutor(spawn);

    await expect(executor.status(configuredProjectRoot)).rejects.toThrow(/JSON/);
  });

  test("rejects invalid acquire identifiers, values, and extra payload fields", () => {
    const invalidPayloads = [
      { ...acquireInput, change: "../escape" },
      { ...acquireInput, requestId: "sandbox/diagnosis" },
      { ...acquireInput, workUnit: "slice 1 proof policy" },
      { ...acquireInput, evidenceGoal: "" },
      { ...acquireInput, maxAttempts: 0 },
      { ...acquireInput, maxChangedLines: 0 },
      { ...acquireInput, maxChangedLines: 1.5 },
      { ...acquireInput, extra: true },
    ];

    for (const payload of invalidPayloads) {
      expect(() => buildSddAttemptAcquireArgv(payload)).toThrow(ValidationError);
    }
  });
});
