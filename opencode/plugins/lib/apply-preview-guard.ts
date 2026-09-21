/**
 * Fail-closed guard for the `sandbox_apply` approval boundary (review finding
 * R1-blind-version-skew-apply).
 *
 * Approval must never be shown a truncated diff without a complete artifact to
 * inspect. When the broker's bounded inline preview is truncated, the approver
 * can authorize the change only if the broker also supplied a complete plain
 * apply-preview artifact. A broker that omits `applyPreviewFiles` on a
 * truncated preview is treated as older/unsupported and refused BEFORE the
 * approval prompt runs.
 *
 * Pure and dependency-free so `broker/tests/apply-preview-guard.test.ts` can
 * exercise it without loading the opencode plugin runtime.
 */
export interface ApplyPreviewFilesLike {
  plain?: string;
  ansi?: string;
}

export interface ApplyApprovalPreviewInput {
  previewTruncated: boolean;
  applyPreviewFiles?: ApplyPreviewFilesLike;
}

export interface ApplyApprovalPaths {
  previewFile?: string;
  previewAnsiFile?: string;
}

export type ApplyApprovalDecision =
  | ({ allowed: true } & ApplyApprovalPaths)
  | { allowed: false; reason: string };

export class ApplyPreviewBlindApprovalError extends Error {
  readonly code = "apply_preview_blind_approval";

  constructor(message: string) {
    super(message);
    this.name = "ApplyPreviewBlindApprovalError";
  }
}

export const BLIND_APPROVAL_REASON =
  "sandbox_apply refused before requesting approval: the broker returned a truncated diff preview " +
  "without a complete apply-preview artifact (applyPreviewFiles.plain is missing). Approval must never " +
  "be blind, and the broker may be older than this plugin. No approval was requested and nothing was applied.";

/** Decide whether approval may proceed and which artifact paths accompany it. */
export function decideApplyPreviewApproval(
  input: ApplyApprovalPreviewInput,
): ApplyApprovalDecision {
  const previewFile = input.applyPreviewFiles?.plain;
  const previewAnsiFile = input.applyPreviewFiles?.ansi;
  if (input.previewTruncated && !previewFile) {
    return { allowed: false, reason: BLIND_APPROVAL_REASON };
  }
  return { allowed: true, previewFile, previewAnsiFile };
}

/**
 * Fail-closed ordering used by the plugin: refuse before `ask` when the
 * decision is not allowed; otherwise invoke `ask` exactly once with the
 * complete artifact paths.
 */
export async function requestApplyApproval(
  input: ApplyApprovalPreviewInput,
  ask: (paths: ApplyApprovalPaths) => Promise<void>,
): Promise<void> {
  const decision = decideApplyPreviewApproval(input);
  if (!decision.allowed) {
    throw new ApplyPreviewBlindApprovalError(decision.reason);
  }
  await ask({ previewFile: decision.previewFile, previewAnsiFile: decision.previewAnsiFile });
}
