import { describe, expect, test } from "bun:test";
import { evaluate, parsePluginList, type AgentInfo } from "../../scripts/check-v2-stack.ts";

const rule = (action: string, effect: string, resource = "*") => ({ action, resource, effect });
const RELAY = ["risk", "resilience", "readability", "reliability", "refuter", "validator"].map((n) => `asi-review-${n}`);

function healthyAgents(): AgentInfo[] {
  const base = [rule("*", "allow"), rule("shell", "deny"), rule("edit", "deny"), rule("read", "deny", "**/*.pem"), rule("read", "deny", "**/.ssh/**")];
  return [
    { id: "gentle-orchestrator", mode: "primary", hidden: false, permissions: base },
    ...RELAY.map((id) => ({ id, mode: "subagent", hidden: true, permissions: base })),
  ];
}

const PLUGIN_TABLE = `ID                          VERSION  SOURCE
aft-opencode                0.62.0   @cortexkit/aft-opencode@~0.62.0
astra-sol-upgrade           local    /x/plugins/astra-sol-upgrade.ts
opencode-magic-context      0.49.30  @cortexkit/opencode-magic-context@~0.49.29
rate-limit-fallback-mapped  local    /x/vendor/opencode-rate-limit-fallback-mapped
systematic                  3.27.2   @fro.bot/systematic@~3.27.2
systematic-routing-guard    local    /x/plugins/systematic-routing-guard.ts
workflow-health-check       local    /x/plugins/workflow-health-check.ts
sandbox-tools               local    /x/plugins/sandbox-tools.ts
routing-guard               local    /x/plugins/00-routing-guard.ts
reviewer-relay-transport    local    /x/plugins/reviewer-relay-transport.ts
`;

const failures = (agents: AgentInfo[], table: string) => evaluate(agents, parsePluginList(table)).filter((r) => !r.ok).map((r) => r.name);

describe("parsePluginList", () => {
  test("reads the table into ids", () => {
    expect(parsePluginList(PLUGIN_TABLE)).toContain("sandbox-tools");
    expect(parsePluginList(PLUGIN_TABLE)).toHaveLength(10);
  });
  test("a plugin that failed to load shows as '-'", () => {
    expect(parsePluginList("ID VERSION SOURCE\n-  1.0.0  x\n")).toEqual(["-"]);
  });
  test("an empty answer is no plugins", () => {
    expect(parsePluginList("No plugins found\n")).toEqual([]);
  });
});

describe("evaluate", () => {
  test("a healthy stack passes every check", () => {
    expect(failures(healthyAgents(), PLUGIN_TABLE)).toEqual([]);
  });

  test("host shell allowed for the orchestrator fails", () => {
    const agents = healthyAgents();
    agents[0]!.permissions = [rule("*", "allow"), rule("shell", "allow")];
    expect(failures(agents, PLUGIN_TABLE)).toContain("orchestrator: host shell denied");
  });

  test("the LAST matching rule decides (a later allow overrides an earlier deny)", () => {
    const agents = healthyAgents();
    agents[0]!.permissions = [rule("shell", "deny"), rule("shell", "allow"), rule("edit", "deny")];
    expect(failures(agents, PLUGIN_TABLE)).toContain("orchestrator: host shell denied");
  });

  test("host edit allowed fails", () => {
    const agents = healthyAgents();
    agents[0]!.permissions = [rule("shell", "deny"), rule("edit", "allow")];
    expect(failures(agents, PLUGIN_TABLE)).toContain("orchestrator: host edit denied");
  });

  test("a missing orchestrator fails", () => {
    expect(failures(healthyAgents().slice(1), PLUGIN_TABLE)).toContain("orchestrator: present");
  });

  test("a missing relay agent fails", () => {
    expect(failures(healthyAgents().filter((a) => a.id !== "asi-review-risk"), PLUGIN_TABLE)).toContain("relay agents: all 6 present, hidden subagents");
  });

  test("a relay agent that is not hidden fails", () => {
    const agents = healthyAgents();
    agents[1]!.hidden = false;
    expect(failures(agents, PLUGIN_TABLE)).toContain("relay agents: all 6 present, hidden subagents");
  });

  test("secret-read denials missing fails", () => {
    const agents = healthyAgents();
    agents[0]!.permissions = [rule("shell", "deny"), rule("edit", "deny")];
    expect(failures(agents, PLUGIN_TABLE)).toContain("orchestrator: secret reads denied");
  });

  test("a missing plugin fails and is named", () => {
    const results = evaluate(healthyAgents(), parsePluginList(PLUGIN_TABLE.replace(/^routing-guard .*\n/m, "")));
    const bad = results.find((r) => !r.ok);
    expect(bad?.name).toBe("plugins: all expected loaded");
    expect(bad?.detail).toContain("routing-guard");
  });

  test("a plugin that failed to load fails", () => {
    expect(failures(healthyAgents(), PLUGIN_TABLE + "-  9.9.9  broken\n")).toContain("plugins: none failed to load");
  });
});
