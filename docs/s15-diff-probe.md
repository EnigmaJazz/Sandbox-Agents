# S15 Diff Probe

This file is a live probe of whether the apply-approval prompt exposes the
actual diff to the human reviewer.

The delta exported by sandbox_finish is a git bundle imported under
refs/opencode-sandbox/result/<sessionID>; sandbox_apply then presents a
permission prompt whose metadata should let the reviewer see what will
change on the host before approving.

Sections:
- Write step: sandbox_write creates the file in the worker.
- Finish step: sandbox_finish exports the result.
- Apply step: sandbox_apply shows the prompt, then applies on approval.

Second probe - modified file:
- The baseline already contained the section above.
- This probe appends content, so the B->C delta is a real modification
  (+/- hunks), which is the harder case for a diff preview to show.
- Target: can the reviewer expand the approval prompt to see these lines?

Third probe - diff rendering after the plugin change:
- The plugin now passes the diff body into the approval prompt metadata.
- This probe verifies the reviewer can actually SEE the changed lines.
- Added line one for the diff.
- Added line two for the diff.
- Added line three for the diff.
