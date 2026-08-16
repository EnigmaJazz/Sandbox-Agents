# OpenCode plugins (Gate 1: code, not installed)

Two plugins implement the OpenCode side of the sandbox integration, verified
against the **opencode 1.18.18** plugin API during discovery
(`~/.opencode/node_modules/@opencode-ai/plugin` typings — see
`docs/discovery-report.md` §3).

| File | Purpose | Spec |
|---|---|---|
| `lib/broker-client.ts` | Shared NDJSON client for the broker Unix socket (also used by `cli/sandboxctl`) | §6 |
| `sandbox-tools.ts` | Stage A explicit tools: `sandbox_read/list/grep/write/edit/apply_patch/bash/diff/finish/apply/discard` via the `tool` hook; lazy worker activation | §11, §12, §28 |
| `routing-guard.ts` | Read-routing guard on `tool.execute.before` (fails closed after `SANDBOX_ACTIVE`), blocks ordinary host mutation tools, injects the routing rule via `experimental.chat.system.transform` | §13, §14 |

## How custom tools work in opencode 1.18.x

Custom tools are declared **by plugins** through the `tool` hook:

```ts
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";

export default function myPlugin() {
  return {
    tool: {
      my_tool: tool({
        description: "...",
        args: { path: z.string() },
        execute: async (args, ctx) => {
          // ctx: { sessionID, messageID, agent, directory, worktree, abort, metadata(), ask() }
        },
      }),
    },
  };
}
```

The `tools` config key is only a boolean enable/disable map in 1.18.x
(discovery §3) — that is why `opencode/tools/` contains no `.ts` files
(see `opencode/tools/README.md`).

## Load order

Load `routing-guard.ts` and `sandbox-tools.ts` together (order between them
does not matter). Both are installed by `scripts/install-user-files`
(Gate 2+). If the broker is not running, `sandbox_*` tools fail closed and the
guard blocks project reads once the broker reports an active session — the
plugins never fall back to host execution.

## Gate notes

- `ctx.ask()` is used by `sandbox_apply` for the §19.9 approval. The exact
  signature is verified at Gate 4 against the installed opencode; if the
  installed API differs, adjust `sandbox-tools.ts` before Gate 5.
- Plugin files are typechecked at Gate 4 against the installed
  `@opencode-ai/plugin` + `zod` typings (they are not part of the broker
  `tsconfig.json`, which must stay dependency-free for `bun test`).
- `sandbox_bash` is intentionally NOT a shell: `tokenizeCommand` splits on
  whitespace/quotes only, and the broker re-validates every token (§28). No
  pipes, redirection, globs or expansion.

## Gate 4 verification (2026-08-16)

Verified against the installed `@opencode-ai/plugin` typings (opencode
1.18.18 at `~/.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts`):

- `tool` hook / `tool()` helper with zod args + `ToolContext`
  `{sessionID, messageID, agent, directory, worktree, abort, metadata, ask}` —
  matches `sandbox-tools.ts` usage.
- `ctx.ask(input: AskInput): Promise<void>` with
  `AskInput = {permission, patterns, always, metadata}` — `sandbox_apply`
  rewritten at Gate 4 from the wrong `{title, body, options}` + return-value
  shape to the typed shape (denial rejects the promise).
- `tool.execute.before(input: {tool, sessionID, callID}, output: {args})` —
  matches `routing-guard.ts`.
- `experimental.chat.system.transform`: `output.system` is `string[]` —
  `routing-guard.ts` rewritten to push (was string assignment).
- `permission.ask` hook available for config-fragment-level enforcement.

### Live-load verification (2026-08-16, isolated)

Verified plugin loading in a REAL opencode 1.18.18 process WITHOUT touching
the live global plugins dir: scratch config via `XDG_CONFIG_HOME` redirect
(`/tmp/oc-plugin-test/opencode/`, plugins copied from the repo). Results:

- `sandbox-tools.ts` tools registered: `sandbox_read`/`sandbox_bash` etc.
  present in the model toolset; `sandbox_bash` with the broker down fails
  closed (`Failed to connect` — S14).
- `routing-guard.ts` active: the ordinary `bash` tool was blocked with the
  exact S1/S10 redirect message in a live run.
- Cosmetic: opencode 1.18.18 also scans plugins-dir .ts files as command
  candidates and logs `failed to load plugin ... error="empty command"` for
  plugin files — the plugin itself loads fine (tools work); the line is
  expected and harmless.

Global install of the plugins is deliberately deferred until the broker
runs and other opencode sessions are idle (fail-closed guard + broker-first
ordering; Gate 4 decision, user).
