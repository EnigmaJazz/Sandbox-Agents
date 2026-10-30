#!/usr/bin/env bun
/**
 * check-v2-stack - read-only health check of the RUNNING secured OpenCode V2 server (docs/upgrades/opencode-v2-install-checklist.md).
 *
 *   bun scripts/check-v2-stack.ts [--server http://127.0.0.1:4097] [--opencode PATH] [--password-file FILE] [--wait SECONDS]
 *
 * It asks the server for its agents (`opencode2 debug agents`) and its plugins (`plugin list`) and prints one PASS or FAIL line per
 * check: the orchestrator cannot use the host shell or edit tools, secret reads are denied, the six reviewer relay agents exist as
 * hidden subagents, and all ten plugins are loaded (none failed). Exit code 0 only if every check passes. The password is read from
 * the 0600 file, handed to the CLI through OPENCODE_PASSWORD and never printed. The first call after a start can take a minute while
 * the packages install, so it retries until --wait (default 120 s).
 *
 * Gate 1: NOT installed. Delivery is manual (S17).
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Rule { action: string; resource: string; effect: string }
export interface AgentInfo { id: string; mode: string; hidden?: boolean; permissions: Rule[] }
export interface CheckResult { name: string; ok: boolean; detail: string }

const RELAY = ["risk", "resilience", "readability", "reliability", "refuter", "validator"].map((n) => `asi-review-${n}`);
export const EXPECTED_PLUGINS = [
  "aft-opencode", "astra-sol-upgrade", "opencode-magic-context", "rate-limit-fallback-mapped", "systematic",
  "systematic-routing-guard", "workflow-health-check", "sandbox-tools", "routing-guard", "reviewer-relay-transport",
];

/** The ids in a `plugin list` table (a plugin that failed to load has the id `-`). */
export function parsePluginList(text: string): string[] {
  return text.split("\n").map((line) => line.trim().split(/\s+/)).filter((p) => p.length >= 3 && p[0] !== "ID" && /^(\d|local)/.test(p[1]!)).map((p) => p[0]!);
}

/** The effect of the LAST rule that matches the action with the catch-all resource (later rules win in V2). */
function effectOf(rules: Rule[], action: string): string | undefined {
  return rules.filter((r) => r.action === action && r.resource === "*").pop()?.effect;
}

export function evaluate(agents: AgentInfo[], plugins: string[]): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
  const orchestrator = agents.find((a) => a.id === "gentle-orchestrator");
  add("orchestrator: present", !!orchestrator, orchestrator ? "" : "no agent named gentle-orchestrator");
  if (orchestrator) {
    for (const action of ["shell", "edit"]) {
      const effect = effectOf(orchestrator.permissions, action);
      add(`orchestrator: host ${action} denied`, effect === "deny", `effective rule: ${effect ?? "none (allowed by the base rule)"}`);
    }
    const denies = orchestrator.permissions.filter((r) => r.action === "read" && r.effect === "deny").map((r) => r.resource);
    const secrets = ["**/.ssh/**", "**/*.pem"].filter((p) => !denies.includes(p));
    add("orchestrator: secret reads denied", secrets.length === 0, secrets.length ? `no read deny for ${secrets.join(", ")}` : `${denies.length} read deny rules`);
  }
  const relay = RELAY.map((id) => agents.find((a) => a.id === id));
  const bad = RELAY.filter((id, i) => !relay[i] || relay[i]!.mode !== "subagent" || relay[i]!.hidden !== true);
  add("relay agents: all 6 present, hidden subagents", bad.length === 0, bad.length ? `problem with: ${bad.join(", ")}` : "");
  const missing = EXPECTED_PLUGINS.filter((id) => !plugins.includes(id));
  add("plugins: all expected loaded", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${EXPECTED_PLUGINS.length} loaded`);
  add("plugins: none failed to load", !plugins.includes("-"), plugins.includes("-") ? "a plugin is listed with id '-' (failed to load)" : "");
  return results;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1]! : fallback; };
  const v2 = join(homedir(), ".local/share/opencode-v2");
  const server = option("--server", "http://127.0.0.1:4097");
  const bin = option("--opencode", join(v2, "prefix/node_modules/.bin/opencode2"));
  const passwordFile = option("--password-file", join(v2, "server-password"));
  const wait = Number(option("--wait", "120"));

  const info = statSync(passwordFile);
  if ((info.mode & 0o777) !== 0o600) { console.error(`FAIL password file must have mode 0600: ${passwordFile}`); return 2; }
  const env = { ...process.env, OPENCODE_PASSWORD: readFileSync(passwordFile, "utf8").trim(), OPENCODE_DISABLE_FREE_MODELS: "1", NO_COLOR: "1" };
  const cli = (...argv: string[]) => Bun.spawnSync([bin, ...argv, "--server", server], { env, stdin: "ignore", timeout: 60_000 });

  let agentsText = "";
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    const r = cli("debug", "agents");
    if (r.exitCode === 0) { agentsText = r.stdout.toString(); break; }
    const err = r.stderr.toString();
    if (/rejected the password|requires a password/.test(err)) { console.error("FAIL the server rejected the password (is it the one the service started with?)"); return 2; }
    if (Date.now() > deadline) { console.error(`FAIL no answer from ${server} within ${wait}s: ${err.split("\n")[0]}`); return 2; }
    const reason = /did not finish activating/.test(err) ? "plugins are still installing/activating" : err.split("\n").find((l) => l.trim()) ?? "no answer yet";
    console.error(`waiting for ${server} (${Math.round((deadline - Date.now()) / 1000)}s left): ${reason}`);
    await Bun.sleep(3000);
  }
  const agents = JSON.parse(agentsText.slice(agentsText.indexOf("["))) as AgentInfo[];
  const plugins = parsePluginList(cli("plugin", "list").stdout.toString());
  const results = evaluate(agents, plugins);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  (" + r.detail + ")" : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
