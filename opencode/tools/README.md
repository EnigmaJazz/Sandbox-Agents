# opencode/tools/

This directory documents intent. It intentionally contains **no `.ts` files**.

In opencode 1.18.x custom tools are provided by **plugins** through the `tool`
hook (discovery report §3: the `tools` config key is only an enable/disable
map, and `AgentConfig.tools` is deprecated in favour of `permission`).

The actual implementations live in `opencode/plugins/`:

- `sandbox-tools.ts` — the Stage A `sandbox_*` tool family (§12)
- `routing-guard.ts` — read-routing guard and mutation blocking (§13, §14)

If a future opencode version reintroduces standalone tool files, they belong
here — and must be re-verified against the installed schema before use
(§12: never guess built-in schemas).
