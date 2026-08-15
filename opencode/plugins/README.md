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
