import { expect, test } from "bun:test";
import { TOOL_CLASSIFICATION_INVENTORY, classifyOperation } from "../src/role-policy.ts";
import { validateEnvelope, ValidationError } from "../src/validation.ts";
import { buildToolAdmissionOp } from "../src/service.ts";

const expectedTools = [
  "read", "grep", "glob", "codegraph_codegraph_explore", "sandbox_read", "sandbox_list", "sandbox_grep", "sandbox_diff",
  "sandbox_write", "sandbox_edit", "sandbox_apply_patch", "sandbox_finish", "sandbox_apply", "sandbox_copy_in", "sandbox_copy_out", "sandbox_discard", "sandbox_bash",
  "bash", "edit", "write", "apply_patch", "patch", "read", "grep", "glob", "list", "task", "question", "skill", "systematic_skill", "systematic_workflow_start", "systematic_workflow_status", "systematic_workflow_complete",
  "host_sandbox_result", "host_sandbox_result_install", "host_review_assess", "host_review_mode_status", "host_review_status", "host_review_lens_context", "host_review_diff_read", "host_review_materialize", "host_review_pipeline_run", "host_review_persist", "host_git_commit", "host_git_clear_commit_intent", "host_git_push", "host_gh_issue_create", "host_plan_append", "host_review_start", "host_review_capture_result", "host_review_capture_unachievable", "host_review_acknowledge_approved", "host_review_capture_correction_plan", "host_review_capture_refuter", "host_review_capture_validation", "host_review_validate", "host_review_recover", "host_register_project", "host_sdd_status", "host_sdd_continue", "host_sdd_task_result", "host_sdd_archive_compose", "host_sdd_attempt_grant",
  "aft_outline", "aft_zoom", "aft_search", "aft_callgraph", "aft_inspect", "aft_safety", "aft_import", "ast_grep_replace", "vision-bridge_describe_image", "webfetch", "github",
];

test("tool inventory explicitly classifies expected tools and leaves invented names unclassified", () => {
  for (const tool of expectedTools) {
    expect(TOOL_CLASSIFICATION_INVENTORY[tool], tool).toBeDefined();
    expect(classifyOperation(tool), tool).not.toBeNull();
  }
  expect(classifyOperation("invented_unlisted_tool")).toBeNull();
});

test("AFT read and host-admin tools retain distinct admission classes", () => {
  for (const tool of ["aft_outline", "aft_zoom", "aft_search", "aft_callgraph", "aft_inspect"]) {
    expect(classifyOperation(tool)).toBe("HOST_READ_STRUCTURED");
  }
  for (const tool of ["aft_safety", "aft_import", "ast_grep_replace"]) {
    expect(classifyOperation(tool)).toBe("HOST_ADMIN_STRUCTURED");
  }
});

test("ordinary built-ins remain outside the admitted tool inventory", () => {
  for (const tool of ["sandbox_apply", "sandbox_bash", "sandbox_finish"]) expect(classifyOperation(tool)).not.toBeNull();
  for (const tool of ["bash", "edit", "write", "apply_patch", "patch"]) expect(classifyOperation(tool)).toBe("HOST_ADMIN_STRUCTURED");
});

test("unknown admission request is denied from the session-bound identity without touching state", async () => {
  let touches = 0;
  const ctx = {
    store: {
      get: () => ({ agent: "worker", state: "HOST_READ_ONLY", projectID: "repo" }),
      touch: () => { touches++; throw new Error("must not touch"); },
    },
    config: { readOnlyAgents: [] },
  } as never;
  const result = await buildToolAdmissionOp(ctx)({
    version: 1, id: "req-1", operation: "toolAdmission", sessionID: "session-1", payload: { tool: "unlisted_tool" },
  } as never) as { classification: string; decision: string; reason: string };
  expect(result.classification).toBe("unclassified");
  expect(result.decision).toBe("deny");
  expect(result.reason).toBeTruthy();
  expect(touches).toBe(0);
});

test("AFT reads are allowed pre-activation while host-admin AFT tools are denied", async () => {
  const ctx = {
    store: { get: () => ({ agent: "researcher", state: "HOST_READ_ONLY", projectID: "repo" }) },
    config: { readOnlyAgents: [] },
  } as never;
  const admission = buildToolAdmissionOp(ctx);
  const request = (tool: string) => admission({
    version: 1, id: "req-1", operation: "toolAdmission", sessionID: "session-1", payload: { tool },
  } as never);
  expect((await request("aft_outline") as { decision: string }).decision).toBe("allow");
  expect((await request("aft_safety") as { decision: string }).decision).toBe("deny");
  expect((await request("aft_import") as { decision: string }).decision).toBe("deny");
  expect((await request("ast_grep_replace") as { decision: string }).decision).toBe("deny");
});

test("toolAdmission rejects invalid tool names at envelope validation", () => {
  const invalid: unknown[] = [null, 1, "", "x".repeat(129), "bad/name"];
  for (const tool of invalid) {
    try {
      validateEnvelope({ version: 1, id: "req-1", operation: "toolAdmission", sessionID: "session-1", payload: { tool } });
      throw new Error("expected invalid tool name to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toMatch(/tool/i);
    }
  }
});
