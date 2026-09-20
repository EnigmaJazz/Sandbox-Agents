# Delta for Host Review Tools

## ADDED Requirements

### Requirement: Diagnostic-only lens context read

`reviewLensContext` MUST remain a read/diagnostic primitive with its existing canonical-root validation, fixed operation contract, and raw provider-block return unchanged. It MUST NOT be deleted, weakened, used as the reviewer transport, or represented as conferring review completion or authority. This corrects the disproven premise that broker-side materialization alone enables the per-lens reviewer step.

#### Scenario: Diagnostic read retained

- GIVEN valid provider selectors for an allowlisted canonical root
- WHEN `reviewLensContext` is called
- THEN it MUST return the raw provider block under its existing read contract
- AND no review authority MUST be created

#### Scenario: Transport is required separately

- GIVEN a reviewer Task must resolve a repository-context binding
- WHEN the review is relayed
- THEN `reviewLensContext` MUST NOT substitute for the session-repository transport

#### Scenario: Existing primitive remains protected

- GIVEN a change to reviewer transport behavior
- WHEN host review-tool behavior is evaluated
- THEN `reviewLensContext` validation and output semantics MUST remain unchanged
