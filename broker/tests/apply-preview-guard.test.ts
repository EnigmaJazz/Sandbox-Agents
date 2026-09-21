/**
 * RED contract tests for the sandbox_apply blind-approval guard.
 *
 * These drive the pure lib helper through injected fakes: no broker socket and
 * no opencode plugin runtime are loaded. They prove the fail-closed invariant
 * from review finding R1-blind-version-skew-apply: a truncated inline preview
 * must never reach the approval prompt without a complete artifact.
 */
import { describe, expect, test } from "bun:test";
import {
  ApplyPreviewBlindApprovalError,
  BLIND_APPROVAL_REASON,
  decideApplyPreviewApproval,
  requestApplyApproval,
  type ApplyApprovalPaths,
} from "../../opencode/plugins/lib/apply-preview-guard.ts";

const artifact = {
  plain: "/state/apply-preview/session.diff",
  ansi: "/state/apply-preview/session.ansi.diff",
};

describe("sandbox_apply blind-approval guard", () => {
  test("truncated preview without an artifact path is refused and ask is never called", async () => {
    let asked = 0;
    const error = await requestApplyApproval({ previewTruncated: true }, async () => {
      asked += 1;
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(asked).toBe(0);
    expect(error).toBeInstanceOf(ApplyPreviewBlindApprovalError);
    const guardError = error as ApplyPreviewBlindApprovalError;
    expect(guardError.code).toBe("apply_preview_blind_approval");
    expect(guardError.message).toBe(BLIND_APPROVAL_REASON);
    expect(guardError.message).toMatch(/truncated/);
    expect(guardError.message).toMatch(/applyPreviewFiles\.plain/);
    expect(guardError.message).toMatch(/older/);
  });

  test("truncated preview with an artifact path proceeds and carries both paths", async () => {
    let asked = 0;
    let seen: ApplyApprovalPaths | undefined;
    await requestApplyApproval(
      { previewTruncated: true, applyPreviewFiles: artifact },
      async (paths) => {
        asked += 1;
        seen = paths;
      },
    );
    expect(asked).toBe(1);
    expect(seen).toEqual({ previewFile: artifact.plain, previewAnsiFile: artifact.ansi });
  });

  test("complete preview without an artifact path proceeds", async () => {
    let asked = 0;
    await requestApplyApproval({ previewTruncated: false }, async () => {
      asked += 1;
    });
    expect(asked).toBe(1);
  });

  test("the refusal is a distinct, actionable error rather than a generic failure", () => {
    const decision = decideApplyPreviewApproval({ previewTruncated: true, applyPreviewFiles: {} });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("expected refusal");
    expect(decision.reason).toBe(BLIND_APPROVAL_REASON);
    expect(decision.reason).toMatch(/complete apply-preview artifact/);
  });

  test("an empty plain path counts as missing and is refused", () => {
    const decision = decideApplyPreviewApproval({
      previewTruncated: true,
      applyPreviewFiles: { plain: "" },
    });
    expect(decision.allowed).toBe(false);
  });
});
