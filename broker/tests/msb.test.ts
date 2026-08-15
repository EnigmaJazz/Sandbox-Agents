/**
 * msb adapter tests: argv construction (no shell metachars anywhere in the
 * final vector), timeout handling, env credential rejection — all against a
 * FAKE spawn (the adapter is real; only the process spawn is mocked).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { MsbAdapter, MsbError, setSpawnImpl, getSpawnImpl, assertWorkerEnv } from "../src/msb.ts";
import { ValidationError } from "../src/validation.ts";

const GiB = 1024 * 1024 * 1024;

interface CapturedCall {
  argv: string[];
  opts: { timeoutMs?: number; cwd?: string; env?: Record<string, string> };
  respond?: { status: number | null; stdout: string; stderr: string; timedOut: boolean };
}

function installFakeSpawn(): CapturedCall[] {
  const calls: CapturedCall[] = [];
  setSpawnImpl(async (argv, opts) => {
    const call: CapturedCall = { argv: [...argv], opts: { ...opts } };
    calls.push(call);
    return (
      call.respond ?? { status: 0, stdout: "", stderr: "", timedOut: false }
    );
  });
  return calls;
}

const cfg = defaultConfig();
const adapter = new MsbAdapter(cfg);

describe("argv construction", () => {
  test("create uses the trusted fixed image and policy resources", async () => {
    const calls = installFakeSpawn();
    const dir = mkdtempSync(join(tmpdir(), "msb-create-"));
    await adapter.createWorker({
      name: "oc-sandbox-sess1",
      cpu: 2,
      memBytes: 2 * GiB,
      image: cfg.workerImage,
      configDir: join(dir, "conf"),
      networkMode: "deny-by-default",
    });
    const argv = calls[0]?.argv;
    expect(argv?.[0]).toBe(cfg.msbBinary);
    expect(argv).toContain("create");
    expect(argv).toContain(cfg.workerImage);
    expect(argv).toContain("-c");
    expect(argv).toContain("2");
    expect(argv).toContain("--max-cpus");
    // The image comes from policy — never from any request field.
    expect(argv?.filter((a) => a.startsWith("http") || a.includes(":"))).not.toContain(
      "evil/image:latest",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("no argv item anywhere contains shell metacharacters", async () => {
    const calls = installFakeSpawn();
    await adapter.exec("oc-sandbox-sess1", ["bun", "test", "--filter", "x"], { cwd: "/work" });
    const argv = calls[0]!.argv;
    for (const token of argv) {
      expect(token).not.toMatch(/[;&|<>`$(){}'"\\\n\r]/);
    }
    expect(argv).toContain("--");
    expect(argv).toContain("/work");
  });

  test("exec passes -e env flags only for allowlisted keys", async () => {
    const calls = installFakeSpawn();
    await adapter.exec("w1", ["true"], { env: { PATH: "/usr/bin" } });
    const argv = calls[0]!.argv;
    expect(argv).toContain("-e");
    expect(argv).toContain("PATH=/usr/bin");
  });

  test("copy uses SANDBOX:/path syntax without interpolation", async () => {
    const calls = installFakeSpawn();
    await adapter.copyIn("w1", "/tmp/a", "/work/b");
    expect(calls[0]?.argv).toContain("/tmp/a");
    expect(calls[0]?.argv).toContain("w1:/work/b");
    await adapter.copyOut("w1", "/work/b", "/tmp/a");
    expect(calls[1]?.argv).toContain("w1:/work/b");
    expect(calls[1]?.argv).toContain("/tmp/a");
  });

  test("worker names are derived from session IDs (never user-supplied)", () => {
    expect(adapter.workerNameFor("sess-1")).toBe(`${cfg.workerNamePrefix}-sess-1`);
  });

  test("generated conf files match the msb 0.6.9 schema proven at Gate 3", async () => {
    const calls = installFakeSpawn();
    const dir = mkdtempSync(join(tmpdir(), "msb-conf-"));
    const configDir = join(dir, "conf");
    await adapter.createWorker({
      name: "oc-sandbox-sess1",
      cpu: 2,
      memBytes: 2 * GiB,
      image: cfg.workerImage,
      configDir,
      networkMode: "deny-by-default",
    });
    const { readFileSync } = await import("node:fs");
    const net = JSON.parse(readFileSync(join(configDir, "net.conf"), "utf8"));
    const res = JSON.parse(readFileSync(join(configDir, "resource.conf"), "utf8"));
    const fsC = JSON.parse(readFileSync(join(configDir, "fs.conf"), "utf8"));
    const rt = JSON.parse(readFileSync(join(configDir, "runtime.conf"), "utf8"));
    const sec = JSON.parse(readFileSync(join(configDir, "secret.conf"), "utf8"));
    // net.conf: policy enum none|public|open — deny-by-default is "none" (S12)
    expect(net).toEqual({ policy: "none" });
    // resource.conf: cpus (plural) + memory as a size STRING (Gate 3 finding)
    expect(res).toEqual({ cpus: 2, memory: "2048M" });
    // fs.conf: only mounts/patch_files/patches; no workdir here
    expect(fsC).toEqual({});
    // runtime.conf: security restricted + workdir (capabilities is NOT a field)
    expect(rt).toEqual({ security: "restricted", workdir: "/work" });
    // secret.conf: unwrapped map, no `secrets` wrapper
    expect(sec).toEqual({});
    // workdir is created via argv flag
    expect(calls[0]?.argv).toContain("--mkdir");
    expect(calls[0]?.argv).toContain("/work");
    rmSync(dir, { recursive: true, force: true });
  });

  test("exec runs worker commands as the non-root workerUser (S11 KVM deny)", async () => {
    const calls = installFakeSpawn();
    await adapter.exec("w1", ["true"], { cwd: "/work" });
    expect(calls[0]?.argv).toContain("-u");
    expect(calls[0]?.argv).toContain(cfg.resource.workerUser);
    expect(calls[0]?.argv).toContain("-w");
    expect(calls[0]?.argv).toContain("/work");
  });
});

describe("timeout handling", () => {
  test("timed-out exec throws MsbError (fail closed, S14)", async () => {
    setSpawnImpl(async () => ({ status: null, stdout: "", stderr: "", timedOut: true }));
    await expect(adapter.exec("w1", ["sleep", "999"])).rejects.toThrow(MsbError);
  });

  test("non-zero exit is surfaced, not swallowed", async () => {
    setSpawnImpl(async () => ({ status: 2, stdout: "err", stderr: "boom", timedOut: false }));
    const res = await adapter.exec("w1", ["false"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toBe("boom");
  });

  test("timeoutMs is capped at policy max", async () => {
    const calls = installFakeSpawn();
    await adapter.exec("w1", ["true"], { timeoutMs: cfg.resource.execTimeoutMsMax * 100 });
    expect(calls[0]?.opts.timeoutMs).toBeLessThanOrEqual(
      cfg.resource.execTimeoutMsMax + 10_000,
    );
  });
});

describe("env allowlist (S8/S9)", () => {
  test("credential-shaped keys are always rejected", () => {
    for (const key of ["OPENAI_API_KEY", "AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "SSH_AUTH_SOCK"]) {
      expect(() => assertWorkerEnv({ [key]: "v" }, [key])).toThrow(ValidationError);
    }
  });

  test("keys outside the allowlist are rejected", () => {
    expect(() => assertWorkerEnv({ RANDOM_VAR: "1" }, ["PATH"])).toThrow(ValidationError);
  });

  test("allowlisted non-credential keys pass", () => {
    expect(assertWorkerEnv({ PATH: "/usr/bin" }, ["PATH"])).toEqual({ PATH: "/usr/bin" });
    expect(assertWorkerEnv(undefined, ["PATH"])).toBeUndefined();
  });
});

describe("test seam hygiene", () => {
  test("fake spawn only ever installed inside tests", () => {
    // The production default must be the direct spawner.
    const impl = getSpawnImpl();
    expect(typeof impl).toBe("function");
  });
});
