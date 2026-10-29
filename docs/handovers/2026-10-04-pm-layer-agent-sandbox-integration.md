# Handover A — project-manager identities (agent-sandbox-integration)

**For:** the agent working in `agent-sandbox-integration`.
**From:** workflow_optimisation (owner decision, 2026-10-04). Queue item Q54 there.
**Self-contained:** you do not need the other handover or any conversation. Line numbers were
read on branch `feat/review-and-state-hardening` on 2026-10-04; re-read before relying on them.

## What is changing on the workflow side

The OpenCode orchestrator loses its routing rules in long sessions (its prompt is about 70,000
characters). The workflow side is moving to a two-level design:

- `gentle-orchestrator` (primary) becomes a strategic front end. It plans, picks a route, and
  dispatches one **project manager (PM)** subagent per work unit. It keeps `host_register_project`
  and the host read tools. It gives up every other host mutation.
- The PM subagents (`pm-odd`, `pm-systematic`, `pm-sdd`) run one work unit to completion: advice,
  writer dispatch, checks, commit, review, tracker update. They are read-only coordinators, as
  the orchestrator is today. They never enter the sandbox themselves.

So the PMs must hold the host mutations the orchestrator holds today (`host_git_commit`,
`host_review_*`, `host_plan_append`, `host_sandbox_result_install`, and the rest of
`HOST_MUTATION_OPERATIONS`).

## Why this needs you

Host mutations are authorised by agent identity, and today the only identity is
`gentle-orchestrator`:

| Where | What |
|---|---|
| `opencode/plugins/sandbox-tools.ts:64` | `READ_ONLY_AGENTS = ["gentle-orchestrator"]`; used by `assertNotOrchestrator` and by the `chat.params` binding (`hostSessionBinding(input, READ_ONLY_AGENTS)`) |
| `broker/src/config.ts:243` | `DEFAULT_READ_ONLY_AGENTS = ["gentle-orchestrator"]` |
| `broker/src/service.ts` `authorizeHostDispatch` | a mutation requires the session record's agent to be in `readOnlyAgents` |
| `broker/src/service.ts` `bindSessionAgent` / `assertBindableAgent` | only an allowlisted agent can be bound; first binding wins |
| `broker/src/role-policy.ts` `shouldRefuseEnsureWorker` | an allowlisted agent can never create a worker |

A PM session calling `host_git_commit` today is refused as "orchestrator-only".

## Requested change

1. Extend the orchestrator-identity allowlist to: `gentle-orchestrator`, `pm-odd`,
   `pm-systematic`, `pm-sdd`, and `pm-probe` (temporary; see "Probe window").
2. Prefer **one configured source** for the list, read by both the broker and the plugin, so the
   two copies cannot drift. If that is not practical, keep two constants and add a test that
   fails when they differ.
3. Keep the per-operation split you already have. Optional refinement, your call: let the
   allowlist say which identities may run which mutation, so that `registerProject` stays with
   `gentle-orchestrator` only and the PMs get the rest. The workflow side will also enforce this
   split through `opencode.json` permissions, so a single flat list is acceptable.

## Invariants that must still hold (please test each)

- **A PM never enters the sandbox.** `ensureWorker` refuses every allowlisted identity, and the
  `sandbox_*` mutation tools refuse them, exactly as for the orchestrator today.
- **The binding is host-resolved.** The agent name comes only from the `chat.params` hook input,
  never from a tool argument or the request envelope.
- **First writer wins.** A session bound to one identity is never rebound to another.
- **Unknown sessions fail closed.** No binding means no mutation.
- **Reads stay open** to every agent.
- **A worker cannot become a PM.** A sandbox-worker session (`general`, `sdd-apply`, `odd-apply`
  and so on) can never be bound to an allowlisted identity, including when it is a child of a PM
  session.

## Questions to answer with evidence

The workflow side could not verify these from outside your project. Please answer each with an
observed result, not an inference.

1. **Subagent binding.** For a child session created by the Task tool, does `chat.params` fire
   with the subagent's own name (`pm-odd`), so the broker binds that child session? Or does it
   carry the parent's name, or not fire at all?
2. **Resumed sessions.** A PM session is resumed with the Task tool's `task_id` after a human
   answer. Is the binding still valid on the resumed turn?
3. **Review relay from a subagent.** Does `opencode/plugins/reviewer-relay-transport.ts` deliver
   the review context when the session that dispatches the `asi-review-*` Task is itself a
   subagent (depth 1), not the primary session?
4. **`assertNotOrchestrator` on reads.** `sandbox_read`, `sandbox_list`, `sandbox_grep` and
   `sandbox_diff` call it. Confirm what a PM gets from these four tools, and state the read
   surface a PM should use instead if they are refused.
5. **Nested depth.** The workflow side will raise `subagent_depth` from 3 to 4. Is any broker or
   plugin behaviour sensitive to session depth or to walking `parentID`?

## Probe window

The workflow side will first run a go/no-go probe with a temporary subagent named `pm-probe`
(read-only, no writer authority). Including `pm-probe` in the allowlist lets that probe exercise
`host_review_start` and `host_git_commit` from a subagent on a throwaway candidate. Remove
`pm-probe` once the workflow side reports the probe closed.

## Acceptance

- Broker and plugin tests cover every invariant above for each new identity.
- The installer and rollback lists are updated if any installed file changes.
- Delivery follows your existing manual gate: the owner reviews and installs the exact bytes.
- You return a short contract statement the workflow side can rely on:
  - the identities that may run host mutations, and any per-operation limits;
  - the answers to the five questions;
  - the restart needed for the change to take effect (`sandbox-broker.service`,
    `secure-opencode.service`).

## Not in scope

- No change to the advisor relay or to `docs/advisor/interface-contract.md`. If you think the
  contract should record the identity list, propose it; the contract changes only by agreement
  of both sides.
- No change to worker roles, sandbox isolation or the review lens transport beyond question 3.
- The workflow side owns `opencode.json`, the PM prompts, the routing guard and the verifier.
