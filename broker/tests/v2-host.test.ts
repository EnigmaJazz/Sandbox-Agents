/**
 * V7 (docs/upgrades/opencode-v2.md): gated V2 host fixture. Runs a REAL OpenCode V2 against the V2 plugins installed by
 * scripts/install-user-files-v2, the V2 config fragments, a scripted OpenAI-compatible provider and a fake broker on a
 * Unix socket. Isolated HOME and XDG roots, loopback only, no real model, no real worker.
 *
 * Off by default (it starts processes). Enable with:
 *   OPENCODE_V2_HOST_TEST=1 OPENCODE_V2_BIN=/path/to/opencode2 bun test tests/v2-host.test.ts
 * The binary must be a V2 CLI and never the V1 install. `zod` is taken from ZOD_DIR or ~/.config/opencode/node_modules/zod
 * (the plugins import it; V2 does not provide it). Without all of these the suite is skipped, visibly.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const BIN = process.env.OPENCODE_V2_BIN ?? "";
const ZOD = process.env.ZOD_DIR ?? join(homedir(), ".config/opencode/node_modules/zod");
const v1Install = join(homedir(), ".opencode");
const enabled =
  process.env.OPENCODE_V2_HOST_TEST === "1" && BIN !== "" && existsSync(BIN) && !resolve(BIN).startsWith(v1Install) && existsSync(ZOD);
const suite = enabled ? describe : describe.skip;
if (!enabled) {
  console.log("[v2-host] skipped: set OPENCODE_V2_HOST_TEST=1, OPENCODE_V2_BIN (a V2 CLI, not ~/.opencode) and have zod available");
}

// --- scripted provider ------------------------------------------------------------------------------------------
type Step = { tool_call: { name: string; arguments: Record<string, unknown> } } | { text: string };
interface ProviderLog { agentTurn: boolean; tools: string[]; messages: any[] }

function startProvider(script: Step[]) {
  const log: ProviderLog[] = [];
  let index = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "probe-model", object: "model" }] });
      }
      const body: any = await request.json();
      const agentTurn = Array.isArray(body.tools) && body.tools.length > 0;
      log.push({ agentTurn, tools: (body.tools ?? []).map((t: any) => t.function?.name), messages: body.messages ?? [] });
      const step: Step = agentTurn ? (script[index++] ?? { text: "done" }) : { text: "Probe title" };
      const chunk = (delta: any, finish: string | null = null) => ({
        id: "chatcmpl-v2host", object: "chat.completion.chunk", created: 0, model: "probe-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      const events: any[] = [chunk({ role: "assistant", content: "" })];
      if ("tool_call" in step) {
        events.push(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: step.tool_call.name, arguments: "" } }] }));
        events.push(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.tool_call.arguments) } }] }));
        events.push(chunk({}, "tool_calls"));
      } else {
        events.push(chunk({ content: step.text }));
        events.push(chunk({}, "stop"));
      }
      events.push({ id: "chatcmpl-v2host", object: "chat.completion.chunk", created: 0, model: "probe-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(payload, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { port: server.port, log, stop: () => server.stop(true) };
}

// --- fake broker -------------------------------------------------------------------------------------------------
interface BrokerCall { operation: string; sessionID: string; agent?: string; payload?: any }
const ALLOWED_TOOLS = new Set(["read", "grep", "glob", "webfetch", "question", "skill", "task"]);

function startBroker(socketPath: string, state: { worker: string }) {
  const calls: BrokerCall[] = [];
  const reply = (operation: string, envelope: any): unknown => {
    switch (operation) {
      case "workerStatus": return { state: state.worker };
      case "policy": return { approvedExternalReadRoots: [] };
      case "bindSessionAgent": return {};
      case "ensureWorker": return {};
      case "readFile": return { content: "FAKE_FILE_CONTENT" };
      case "prepareResult": return {};
      case "diff":
        return { stat: "1 file changed", diff: "+x", applyPreview: { files: 1, addedLines: 1, removedLines: 0, totalLines: 1, preview: "+x", previewTruncated: false } };
      case "applyResult": return { status: "APPLIED" };
      case "toolAdmission": {
        const tool = envelope.payload.tool;
        const allowed = ALLOWED_TOOLS.has(tool);
        return {
          schema: "opencode-sandbox.tool-admission/v1", tool,
          classification: allowed ? "READ_PROJECT" : "unclassified",
          decision: allowed ? "allow" : "deny",
          reason: allowed ? "ok" : "not in the tool inventory",
        };
      }
      default: throw new Error(`fake broker: unexpected operation ${operation}`);
    }
  };
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, data) {
        for (const line of data.toString("utf8").split("\n").filter(Boolean)) {
          const envelope = JSON.parse(line);
          calls.push({ operation: envelope.operation, sessionID: envelope.sessionID, agent: envelope.agent, payload: envelope.payload });
          let response: any;
          try {
            response = { version: 1, id: envelope.id, ok: true, result: reply(envelope.operation, envelope) };
          } catch (error) {
            response = { version: 1, id: envelope.id, ok: false, error: { code: "unexpected", message: String(error) } };
          }
          socket.write(JSON.stringify(response) + "\n");
        }
      },
    },
  });
  return { calls, stop: () => listener.stop(true) };
}

// --- isolated V2 environment -------------------------------------------------------------------------------------
const jsonc = (path: string) =>
  JSON.parse(readFileSync(path, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n"));

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "v2-host-test-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
interface RunOptions { script: Step[]; worker?: string; agent?: string; auto?: boolean; brokerUp?: boolean }

async function runV2(options: RunOptions) {
  const home = join(scratch, `env-${++counter}`);
  mkdirSync(home, { recursive: true });
  const project = join(home, "project");
  mkdirSync(project);
  writeFileSync(join(project, "notes.txt"), "project file\n");
  const env = { HOME: home, BROKER_STATE_DIR: join(home, "state"), PATH: process.env.PATH ?? "" };

  // Install exactly what the installer installs, then stage zod where the plugins resolve it.
  const install = Bun.spawnSync(["bash", join(ROOT, "scripts/install-user-files-v2"), "--apply"], { env, stdin: "ignore" });
  if (install.exitCode !== 0) throw new Error(`installer failed: ${install.stderr.toString()}`);
  const v2root = join(home, ".local/share/opencode-v2");
  const configDir = join(v2root, "config/opencode");
  mkdirSync(join(configDir, "node_modules"), { recursive: true });
  cpSync(ZOD, join(configDir, "node_modules/zod"), { recursive: true });

  const provider = startProvider(options.script);
  const state = { worker: options.worker ?? "HOST_READ_ONLY" };
  const socketPath = join(home, "broker.sock");
  const broker = options.brokerUp === false ? { calls: [] as BrokerCall[], stop: () => {} } : startBroker(socketPath, state);

  const permission = jsonc(join(ROOT, "opencode/plugins-v2/config-fragments/sandbox-permissions.jsonc")).permission;
  const roles = jsonc(join(ROOT, "opencode/plugins-v2/config-fragments/role-agents.jsonc")).agent;
  for (const agent of Object.values<any>(roles)) agent.model = "probe/probe-model";
  const model = { name: "probe-model", tool_call: true, limit: { context: 200000, output: 8192 } };
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: { probe: { npm: "@ai-sdk/openai-compatible", name: "Probe", options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "probe-not-a-secret" }, models: { "probe-model": model } } },
    model: "probe/probe-model", autoupdate: false, share: "disabled", permission, agent: roles,
  }));

  const args = ["run", "--standalone", ...(options.auto === false ? [] : ["--auto"]), "--format", "json", ...(options.agent ? ["--agent", options.agent] : []), "go"];
  const proc = Bun.spawn([BIN, ...args], {
    cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: {
      HOME: home, PATH: process.env.PATH ?? "", NO_COLOR: "1", TMPDIR: join(home, "tmp"),
      XDG_CONFIG_HOME: join(v2root, "config"), XDG_DATA_HOME: join(v2root, "data"), XDG_STATE_HOME: join(v2root, "state"), XDG_CACHE_HOME: join(v2root, "cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", BROKER_SOCKET: socketPath,
    },
  });
  mkdirSync(join(home, "tmp"), { recursive: true });
  const timeout = setTimeout(() => proc.kill(), 90_000);
  const exitCode = await proc.exited;
  clearTimeout(timeout);
  provider.stop();
  broker.stop();
  const toolResults = provider.log.flatMap((entry) => entry.messages.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))));
  return { exitCode, calls: broker.calls, provider: provider.log, toolResults, stderr: await new Response(proc.stderr).text() };
}

const used = (calls: BrokerCall[], operation: string) => calls.filter((call) => call.operation === operation);

suite("V2 host fixture (real OpenCode V2, installed plugins, fake broker)", () => {
  beforeAll(() => {
    expect(resolve(BIN).startsWith(v1Install)).toBe(false);
  });

  test("a sandbox tool reaches the broker with the host-supplied agent, after the session is bound to it", async () => {
    const r = await runV2({ script: [{ tool_call: { name: "sandbox_read", arguments: { path: "notes.txt" } } }, { text: "done" }] });
    expect(r.exitCode).toBe(0);
    const bind = used(r.calls, "bindSessionAgent");
    const read = used(r.calls, "readFile");
    expect(bind.length).toBeGreaterThan(0);
    expect(bind[0]!.payload).toEqual({ agent: "build" });
    expect(read).toHaveLength(1);
    expect(read[0]!.payload).toEqual({ path: "notes.txt" });
    expect(read[0]!.agent).toBe("build");
    expect(r.calls.indexOf(bind[0]!)).toBeLessThan(r.calls.indexOf(read[0]!));
    expect(r.toolResults.join("\n")).toContain("FAKE_FILE_CONTENT");
  });

  test("the guard asks the broker to admit a non-sandbox tool and refuses Code Mode's execute", async () => {
    const r = await runV2({ script: [{ tool_call: { name: "execute", arguments: { code: "1 + 1" } } }, { text: "done" }] });
    expect(r.exitCode).toBe(0);
    expect(used(r.calls, "toolAdmission").some((call) => call.payload.tool === "execute")).toBe(true);
    expect(r.toolResults.join("\n")).toContain("denied by broker admission");
  });

  test("host reads run before activation and are redirected once a worker is active", async () => {
    const script: Step[] = [{ tool_call: { name: "glob", arguments: { pattern: "*.txt" } } }, { text: "done" }];
    const before = await runV2({ script, worker: "HOST_READ_ONLY" });
    expect(before.toolResults.join("\n")).toContain("notes.txt");
    const after = await runV2({ script, worker: "SANDBOX_ACTIVE" });
    expect(after.toolResults.join("\n")).toContain("sandbox_read/sandbox_grep/sandbox_list");
    expect(after.toolResults.join("\n")).not.toContain("notes.txt");
  });

  test("with the broker unreachable the guard refuses a host read (fail closed)", async () => {
    const r = await runV2({ script: [{ tool_call: { name: "glob", arguments: { pattern: "*.txt" } } }, { text: "done" }], brokerUp: false });
    expect(r.toolResults.join("\n")).not.toContain("notes.txt");
    expect(r.toolResults.join("\n")).toMatch(/error/i);
  });

  test("sandbox_apply without approval is rejected and the broker never applies anything", async () => {
    const r = await runV2({ script: [{ tool_call: { name: "sandbox_apply", arguments: {} } }, { text: "done" }], worker: "RESULT_READY", auto: false });
    expect(r.toolResults.join("\n")).toContain("permission.rejected");
    expect(used(r.calls, "applyResult")).toHaveLength(0);
  });

  test("sandbox_apply with approval reaches applyResult (positive control for the rejection above)", async () => {
    const r = await runV2({ script: [{ tool_call: { name: "sandbox_apply", arguments: {} } }, { text: "done" }], worker: "RESULT_READY", auto: true });
    expect(used(r.calls, "applyResult")).toHaveLength(1);
  });

  test("the researcher role is offered only read tools, never a mutating or host tool", async () => {
    const r = await runV2({ script: [{ text: "done" }], agent: "researcher" });
    const offered = new Set(r.provider.find((entry) => entry.agentTurn)!.tools);
    for (const tool of ["sandbox_read", "sandbox_list", "sandbox_grep", "sandbox_diff"]) expect(offered.has(tool)).toBe(true);
    for (const tool of ["sandbox_write", "sandbox_edit", "sandbox_bash", "sandbox_apply", "host_git_commit", "shell", "edit"]) {
      expect([tool, offered.has(tool)]).toEqual([tool, false]);
    }
  });
});
