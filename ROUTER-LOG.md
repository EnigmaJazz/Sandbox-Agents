# Router log

Canonical recipe: `/home/james/ai-workspace/workflow_optimisation/WORKFLOW.md`. This repository's rows are local visible evidence; the workspace log remains authoritative.

| Date | Task | Class | Reclassification | Review outcome | Probe | Evidence |
|---|---|---|---|---|---|---|
| 2026-10-02 | `gentle-ai-4-sdd-dormancy` (T3–T5) | documentation | none | Unreviewed by deferral: accumulated-range review refused twice for size (`lens_context_budget_exceeded`). | no | Commits `5e65f46`, `83f448c`, `8152748`, `7dc3886` |
| 2026-10-02 | `external-advisors A2a` (snapshot pinning) | small feature | none | APPROVED, authority burned; lineage `review-7dc1caa8ea859908`, target `sha256:ac279408…`, consumed `sha256:d2f95f0d…`. | no | Commit `1b3d246`; 675 pass / 0 fail |
| 2026-10-02 | `R3-rotate-race refutation` | bug investigation | none | Finding refuted as a false positive; no correction applied. | no | `broker/src/advisor-records.ts:246-254`; lineage `review-96365efe7a5eaa5e` → recovered → `review-3f9c1a7b5e2d4068` terminal |
| 2026-10-02 | `sandbox cwd/env diagnosis` | bug investigation | none | n/a (diagnosis). | no | `bun --version` 1.3.14 at repo root; `bun test` from `broker/` and `printenv` from `broker/` both return ENOENT |
