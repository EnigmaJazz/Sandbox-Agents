Build the restricted "hostfs" MCP integration for our secure OpenCode system, while strictly respecting the existing write-authority boundaries.

Authority boundary — mandatory

You are authorized to modify only the writable sandbox repository:

"/home/james/agent-sandbox-integration"

You are not authorized to modify:

- "/home/james/ai-workspace/workflow_optimisation"
- "/home/james/.config/opencode"
- "/home/james/.config/systemd/user"
- any active OpenCode plugin directory;
- any other host configuration path.

Read-only inspection of the workflow repository is permitted when the available tools allow it. No agent may directly install, deploy or modify active OpenCode configuration.

Do not ask for these protections to be weakened. Do not attempt to work around them through Bash, MCP, symlinks, alternate paths, subprocesses or temporary mounts.

The required architecture is:

1. Build and test the MCP implementation in the writable sandbox repository.
2. Construct a writable staging copy of the relevant workflow files.
3. Modify only that staging copy.
4. Generate a reviewable, hash-guarded handoff bundle.
5. Provide Fish-compatible commands for the user to apply the bundle.
6. The user-run installer updates the canonical workflow repository.
7. The user-run verifier recovery updates active OpenCode configuration.

A generated patch or installer is not evidence that deployment occurred.

Workflow entry

Load and follow the installed workflow router and applicable secure ODD/Systematic skills.

Treat this as an authorized substantial global-tooling change. The orchestrator remains read-only. All permitted source edits, builds and tests must be delegated to authorized sandbox workers.

Use the current "WORKFLOW.md" and workflow skills when readable. If they are not readable, report that limitation but continue the sandbox-owned implementation without inventing their contents.

Objective

Implement a narrowly scoped, read-only local MCP service that lets approved agents understand selected host directory structure and locate exact configuration files outside the active project.

It must complement rather than replace:

- "aft_outline" and "aft_zoom";
- "codegraph_codegraph_explore";
- "ast_grep_search";
- project and sandbox filesystem tools.

Do not use "hostfs" for normal in-repository code exploration.

MCP implementation

Use the MCP server name "hostfs". Expose exactly these operations, subject to verified OpenCode name-prefix behaviour:

- "hostfs_roots"
- "hostfs_list"
- "hostfs_find_name"
- "hostfs_stat"
- "hostfs_read"

Their behaviour must be:

"hostfs_roots"

Return only configured logical root names, canonical paths and short descriptions.

"hostfs_list"

List directory entries under one configured root.

- Require a logical root and relative path.
- Return metadata, not contents.
- Bound depth, entry count and response size.
- Use deterministic ordering.

"hostfs_find_name"

Find filenames or path components only.

- Never search file contents.
- Require a logical root and bounded relative scope.
- Bound depth, result count and response size.
- Use deterministic ordering.

"hostfs_stat"

Return bounded metadata for one path:

- object type;
- size;
- modification time;
- symlink status;
- whether the target is readable under policy.

"hostfs_read"

Read one explicitly selected regular text file.

- Enforce roots and sensitive-path policy inside the server.
- Reject binary and special files.
- Impose a conservative byte limit.
- Report truncation explicitly.
- Never silently follow a symlink outside policy.

Expose no write, edit, create, move, copy, delete, chmod, shell, execution, lifecycle or arbitrary content-search operation.

Do not install the general filesystem MCP unchanged if it exposes a broader tool surface.

Server-side security

Do not treat MCP Roots as an access-control boundary. Enforce all access in the service and underlying process sandbox.

Intended logical roots are:

- "opencode-config" → "/home/james/.config/opencode"
- "cortexkit-config" → "/home/james/.config/cortexkit"
- "systemd-user" → "/home/james/.config/systemd/user"
- "workflow-optimisation" → "/home/james/ai-workspace/workflow_optimisation"
- "sandbox-integration" → "/home/james/agent-sandbox-integration"
- "local-opencode-autoupdater" → "/home/james/.local/share/opencode-plugin-auto-update-local"

Verify paths where read-only inspection permits. Do not expose "/", "/home/james", arbitrary caller-supplied roots, or the whole OpenCode cache.

For every operation:

- accept only a server-defined logical root;
- accept only relative paths;
- reject absolute paths, null bytes, encoded traversal and "..";
- canonicalize and confirm containment;
- use "lstat" or equivalent checks;
- reject symlink escape and unsafe symlink chains;
- reject devices, sockets, FIFOs and other special files;
- impose depth, item-count, file-size and response-size limits;
- use deterministic output;
- perform no shell execution;
- require no network;
- run without elevated privileges.

Sensitive-path denies must override all allows. Deny at least:

- ".env" and ".env.*", except separately reviewed examples if justified;
- SSH and GPG material;
- private keys and private certificates;
- password, token, secret and credential files;
- OpenCode authentication and MCP OAuth stores;
- keyrings and password stores;
- browser profiles;
- unrelated personal files.

Use focused tests to prove these protections.

Do not expose the package cache through general traversal. If cache diagnostics are needed, propose a separate fixed inventory operation that returns only package, version, path, size and active-reference metadata.

Intended agent permissions

Prepare workflow integration for this permission model, but do not apply it directly.

Global default

Deny "hostfs_*".

"gentle-orchestrator"

Allow:

- "hostfs_roots"
- "hostfs_list"
- "hostfs_find_name"
- "hostfs_stat"

Set "hostfs_read" to "ask".

Retain all existing read-only orchestrator restrictions.

New "host-config-researcher"

Define a dedicated read-only subagent that:

- accepts a bounded host-configuration question;
- uses the five "hostfs" tools;
- cannot edit, execute, delegate or write memory;
- returns exact paths, relevant evidence, denials and limitations;
- avoids unrelated exploration and secret-bearing output;
- stops when the bounded objective is satisfied.

"hostfs_read" may be allowed for this specialist only if server-side restrictions are comprehensively tested. Otherwise keep it "ask".

Use an existing suitable read-only model. Do not change model or fallback allocation for this work.

All other agents

Do not grant "hostfs_*" to:

- "general";
- implementation agents;
- SDD apply agents;
- frontend implementation agents;
- ordinary repository researchers;
- Systematic reviewers;
- isolated RDD/4R reviewers;
- "sdd-research";
- vision agents.

Agents needing host information must request a bounded inspection through the orchestrator and "host-config-researcher".

Workflow behaviour to stage

Prepare staged workflow changes expressing:

1. Use AFT, CodeGraph and AST search inside repositories.
2. Use hostfs metadata tools only for approved host paths outside the project.
3. Use orchestrator "hostfs_read" only for a necessary, exact file and with approval.
4. Delegate multi-directory or content-bearing host investigation to "host-config-researcher".
5. Include logical roots, objective, expected evidence and scope limits in the Task brief.
6. Treat missing or denied access as a limitation, not authority to use Bash or broader traversal.
7. Never give hostfs access to isolated reviewers or implementation workers.
8. After compaction, retain relevant paths and findings rather than directory dumps.

Keep global "AGENTS.md" lightweight. Put detailed procedure in the appropriate scoped workflow skill.

Sandbox-owned deliverables

Implement and commit the following in the writable sandbox repository:

- MCP server source;
- root/policy configuration schema;
- sensitive-path policy;
- unit tests;
- MCP protocol integration tests;
- build configuration;
- local package/build manifest;
- operator documentation;
- a manifest describing the required workflow integration;
- the handoff bundle generator;
- generated workflow patch or overlay;
- Fish-compatible apply and rollback scripts;
- preimage and output checksum manifests.

Use the existing repository’s conventions where available.

The built server must use a stable local entrypoint. Do not configure "npx -y", a floating package version or network installation at OpenCode startup.

Read-only workflow source and staging

If "/home/james/ai-workspace/workflow_optimisation" is readable:

1. Record its Git commit, dirty-state summary and SHA-256 hashes of every input file used.
2. Copy only the necessary files into a staging directory beneath the writable sandbox repository.
3. Preserve paths and permissions.
4. Apply proposed workflow changes only to the staging copy.
5. Generate a minimal patch against the recorded source.
6. Generate a manifest mapping every source file to:
   - expected original SHA-256;
   - proposed resulting SHA-256;
   - intended mode;
   - reason for change.

Expected workflow inputs may include:

- "WORKFLOW.md"
- "verify-workflow.sh"
- "global-config/AGENTS.md"
- "global-config/opencode.json"
- "global-config/tui.json"
- "global-config/plugins/workflow-health-check.ts"
- relevant "global-config/skills/**" files
- "config-manifest-host-tools.md"
- other files proven necessary by current repository structure.

Do not stage or change unrelated files.

If the workflow repository is not readable, complete the MCP implementation and produce:

- a precise integration manifest;
- proposed snippets or templates;
- a list of exact source files and hashes still required.

Do not fabricate a patch against unseen files.

Handoff bundle

Create a self-contained handoff directory such as:

"integration-output/hostfs-workflow-integration/"

It must include:

- "workflow-integration.patch"
- "preimage-sha256.txt"
- "result-sha256.txt"
- "apply-hostfs-integration.fish"
- "rollback-hostfs-integration.fish"
- "install-hostfs-runtime.fish"
- "README.md"
- built-runtime manifest or reproducible build instructions;
- complete test report.

The apply script must:

1. target exactly "/home/james/ai-workspace/workflow_optimisation";
2. refuse any other target unless explicitly supplied and validated;
3. verify every preimage hash before changing anything;
4. fail without mutation if any hash differs;
5. require a clean or explicitly acknowledged workflow worktree;
6. create a timestamped backup outside the files being changed;
7. run "git apply --check" or equivalent before applying;
8. apply only the reviewed patch;
9. verify every resulting hash;
10. print the backup location and next commands;
11. never touch active "~/.config/opencode".

The rollback script must:

- validate that the installed files match the expected post-apply hashes;
- refuse ambiguous rollback;
- restore from the specific timestamped backup;
- preserve subsequent unrelated changes;
- report what was restored.

The runtime installation script may be run only by the user. It must:

- build from the reviewed sandbox-repository commit or install a hash-verified artifact;
- install to a dedicated local location, not the plugin cache;
- avoid modifying active OpenCode config directly;
- verify the installed runtime digest;
- instruct the user to run workflow recovery afterward.

Do not execute any handoff, installation or rollback script from the agent session.

Staged verifier changes

Prepare, in the staging copy only, verifier logic that checks:

- the local MCP runtime exists;
- its digest/version matches the reviewed manifest;
- OpenCode points to the pinned local entrypoint;
- exactly five approved MCP tools exist;
- no write or arbitrary-content-search tool exists;
- roots match the reviewed allowlist;
- "/" and broad "/home/james" roots are absent;
- sensitive-path policy and limits match reviewed values;
- "hostfs_*" is globally denied;
- orchestrator permission is four allow plus one ask;
- "host-config-researcher" has the exact reviewed surface;
- other agents do not inherit hostfs tools;
- workflow router and skills contain the route contract;
- the local auto-update URI remains exactly:
  "file:///home/james/.local/share/opencode-plugin-auto-update-local/dist/index.js"
- active secure OpenCode has loaded current files after restart.

Any recovery logic must back up files and fail closed on symlinks, malformed destinations or ambiguous state. It must preserve unrelated configuration.

Update staged "VERIFY_SCRIPT_SHA256" only after the staged verifier is final.

Tests

Run tests in temporary fixture roots, never against real secret-bearing directories.

Cover:

- root listing;
- shallow directory listing;
- deterministic ordering;
- filename-only search;
- stat;
- small text read;
- oversize truncation;
- binary rejection;
- absolute-path rejection;
- traversal and encoded-traversal rejection;
- symlink escape and chain rejection;
- sensitive-name rejection;
- auth-file rejection;
- special-file rejection where safely testable;
- depth, item and response limits;
- missing roots;
- absence of mutation tools from MCP "tools/list";
- concurrent reads without state leakage;
- staged per-agent permission resolution;
- denial for implementation and isolated-review agents.

Exercise MCP initialization, "tools/list", and each operation against temporary roots.

For staged workflow recovery, test against a temporary fake OpenCode configuration, including:

- clean recovery;
- idempotent second run;
- deliberate drift restoration;
- symlink refusal;
- preimage-hash mismatch refusal;
- preservation of the local auto-update URI.

Do not run recovery against the live config.

Existing policies that must not change

Do not change:

- "grep: ask";
- Nono security boundaries;
- peak policy;
- model assignments or fallback ordering;
- Astra selection policy;
- Magic Context behaviour;
- Gentle AI/Systematic routing except for the narrow hostfs addition;
- TUI plugin-discovery requirements;
- the local auto-update plugin URI;
- cache-pruning service behaviour.

Do not add a cache-prune systemd pre-hook.

Completion

Commit only sandbox-repository changes using Conventional Commits. Do not push.

Do not commit or claim to commit the workflow-repository changes; they exist only as a generated handoff until the user applies them.

Report:

- architecture and security decisions;
- sandbox files changed;
- MCP tools and limits;
- logical roots and deny rules;
- test commands and observed results;
- sandbox commit hash;
- workflow source commit/hash used to generate the patch;
- every staged workflow file;
- handoff bundle path and checksum;
- exact Fish commands the user must run;
- expected verifier output;
- checks that remain pending until user deployment;
- rollback command.

Clearly distinguish these states:

- built and tested in sandbox;
- staged for workflow integration;
- applied to workflow repository;
- installed locally;
- recovered into active OpenCode config;
- loaded by restarted secure OpenCode.

At completion, only the first two states may be claimed by the agent.
