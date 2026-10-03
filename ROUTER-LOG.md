# Router log

Canonical recipe: `/home/james/ai-workspace/workflow_optimisation/WORKFLOW.md`. This repository's rows are local visible evidence; the workspace log remains authoritative.

| Date | Task | Class | Reclassification | Review outcome | Probe | Evidence |
|---|---|---|---|---|---|---|
| 2026-10-02 | `gentle-ai-4-sdd-dormancy` (T3–T5) | documentation | none | Unreviewed by deferral: accumulated-range review refused twice for size (`lens_context_budget_exceeded`). | no | Commits `5e65f46`, `83f448c`, `8152748`, `7dc3886` |
| 2026-10-02 | `external-advisors A2a` (snapshot pinning) | small feature | none | APPROVED, authority burned; lineage `review-7dc1caa8ea859908`, target `sha256:ac279408…`, consumed `sha256:d2f95f0d…`. | no | Commit `1b3d246`; 675 pass / 0 fail |
| 2026-10-02 | `R3-rotate-race refutation` | bug investigation | none | Finding refuted as a false positive; no correction applied. | no | `broker/src/advisor-records.ts:246-254`; lineage `review-96365efe7a5eaa5e` → recovered → `review-3f9c1a7b5e2d4068` terminal |
| 2026-10-02 | `sandbox cwd/env diagnosis` | bug investigation | none | n/a (diagnosis). | no | `bun --version` 1.3.14 at repo root; `bun test` from `broker/` and `printenv` from `broker/` both return ENOENT |
| 2026-10-02 | `record corrections and boundary advance` | documentation | none | `passive` — assessment of `3253224` gave 3 paths / 29 lines, reason `non_executable_only`, so the boundary advanced without review to `3253224`. | no | Commits `3253224` and this correction commit |
| 2026-10-02 | `commit-message newlines (Tier 3 item 1)` | tiny fix | none | pending — committed as `a81532d`, assessment against boundary `d52abca` recorded separately | no | Commit `a81532d`; 681 pass / 0 fail; installed and restarted by the user |
| 2026-10-02 | `worker-reuse snapshot compatibility (R4-001 regression)` | bug investigation | none | APPROVED, authority burned — lineage `review-1d6a74037c5ca7ee`, target `sha256:0575568f…`, consumed `sha256:96c0522d…`; the RED reproduced the live failure verbatim (`snapshot differs from the existing worker snapshot` at `service.ts:730`, from the reuse path at `service.ts:324`) | no | Commit `d9f8bf9`; 688 pass / 0 fail |
| 2026-10-02 | `external-advisors A2b (resultDiff)` | small feature | none | APPROVED, authority burned — lineage `review-b667dec3b77de0d2`, target `sha256:c309aa8a…`, consumed `sha256:b05f494f…`; two non-blocking advisories queued | no | Commit `deecdeb`; 693 pass / 0 fail |
