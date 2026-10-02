# Claim retractions

Canonical recipe: `/home/james/ai-workspace/workflow_optimisation/WORKFLOW.md`. This repository's rows are local visible evidence; the workspace log remains authoritative.

| Claim | What caught it | Instrument that should have preceded it |
|---|---|---|
| “bun is unavailable in the sandbox” (reported twice, attributed to TODO Tier 2 item 14). | `bun --version` at the project root succeeds (1.3.14), while `bun test` from `broker/` returns ENOENT; `printenv` also ENOENTs from `broker/`. | Differential probe: run the same command from two working directories before asserting unavailability. |
| `R3-rotate-race` is a CRITICAL non-atomic read-modify-write race. | Source reading: `rotateHost` is fully synchronous with no `await` between read and write; the pre-existing ten-concurrent-ask test passes unmodified; cited evidence (`:178-188`) points at unrelated functions. | Require a RED test before accepting a defect claim. |
| The client-framer change made large-file timeouts visible and fixed them. | The user's in-memory socket experiment showed `socket.write` truncating at ~219 KB (the kernel send buffer), proving the real cause was elsewhere. | Out-of-band reproduction of the reported symptom before claiming a fix. |
| A worker's result was ready to apply. | The user rejected a zero-diff `sandbox_apply` preview. | Assert the prepared diff is non-empty and names the changed paths before invoking apply. |
