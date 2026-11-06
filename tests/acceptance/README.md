# tests/acceptance/

Gated end-to-end acceptance (Gates 9 + 10): the §33 success-condition flow
(host reads → lazy worker → sandbox edits/tests → result → approved apply),
OpenChamber integration with the single secured server, and host-admin
read/mutation behaviour.

```sh
SANDBOX_GATED_TESTS=acceptance bun test tests/acceptance/
```

Requires the fully installed stack (broker service, nono profile, plugins,
OpenChamber). Skipped by default. Adversarial review (spec §29) remains a
separate manual step with a dedicated reviewer agent.

## Staging chains (P6, criteria S88/S89)

`staging.acceptance.test.ts` covers the staged work chain: ordered build, no host change before apply,
review before apply and strict apply order, reject then STALE then rebuild, protected paths never applied
through the chain, role separation, and the refusal of a stage the reviewer cannot see in full.

```sh
STAGING_ACCEPTANCE=dry bun test tests/acceptance/staging.acceptance.test.ts      # fake worker adapter (no sandbox)
SANDBOX_GATED_TESTS=staging bun test tests/acceptance/staging.acceptance.test.ts # installed stack: real msb workers
```

The dry run only shows that the assertions work. Only the stack run, executed by the owner, is acceptance
evidence, and the owner's sign-off is recorded in `odd/tasks/staging-chains.md`. No agent self-certifies.
