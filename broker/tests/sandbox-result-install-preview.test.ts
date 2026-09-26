import { describe, expect, test } from "bun:test";
import { buildSandboxResultInstallAsk } from "../../opencode/plugins/lib/host-tool-approval.ts";
import { requestApplyApproval } from "../../opencode/plugins/lib/apply-preview-guard.ts";

describe("sandbox result install approval preview", () => {
  test("truncated preview without a complete artifact refuses before approval", async () => {
    let asked = 0;
    await expect(requestApplyApproval({ previewTruncated: true }, async () => { asked += 1; }))
      .rejects.toThrow(/truncated diff preview/);
    expect(asked).toBe(0);
  });

  test("approval metadata carries the complete preview artifact path and bounded diff", () => {
    const ask = buildSandboxResultInstallAsk({
      resultRef: "refs/opencode-sandbox/result/worker-7",
      resultCommit: "0123456789abcdef0123456789abcdef01234567",
      previewFile: "/state/apply-preview/worker-7.diff",
      preview: "diff --git a/a.ts b/a.ts\n+shown change",
      previewTruncated: false,
    });
    expect(ask.metadata.previewFile).toBe("/state/apply-preview/worker-7.diff");
    expect(ask.metadata.preview).toContain("+shown change");
  });

  test("caps oversized approval previews without losing the truncation marker", () => {
    const ask = buildSandboxResultInstallAsk({
      resultRef: "refs/opencode-sandbox/result/worker-7",
      resultCommit: "0123456789abcdef0123456789abcdef01234567",
      preview: "+change\n".repeat(2_000),
      previewTruncated: true,
      previewFile: "/state/apply-preview/worker-7.diff",
    });
    expect(ask.metadata.preview.length).toBeLessThanOrEqual(12_000);
    expect(ask.metadata.preview).toContain("approval preview truncated");
    expect(ask.metadata.previewTruncated).toBe("yes");
    expect(ask.metadata.previewFile).toBe("/state/apply-preview/worker-7.diff");
  });

  test("large complete preview remains eligible for approval", async () => {
    let asked = 0;
    await requestApplyApproval({ previewTruncated: false }, async () => { asked += 1; });
    expect(asked).toBe(1);
  });
});
