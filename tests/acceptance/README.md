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
