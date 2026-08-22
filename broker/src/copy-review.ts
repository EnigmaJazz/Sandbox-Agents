/**
 * Copy-out review: conservative source-code classification + line-limit gate.
 *
 * Guards the S15 copy tool (sandbox_copy_out) so a source-code target cannot be
 * written to the host at a size the fully visible review preview could not show
 * (maxApplyDiffLines, default 200). Documents and artifacts (.md, .txt, .log,
 * .pdf, images, ...) are never classified as source code and stay transferable
 * regardless of size.
 *
 * Conservative by design (spec §30): only extensions that are unambiguously
 * source code are classified — never generic docs, data files, or binary
 * artifacts.
 */
import { extname } from "node:path";
import { ValidationError } from "./validation.ts";

/**
 * Extensions treated as source code for copy-out review. Kept deliberately
 * narrow: the gate bounds source code by the fully visible review limit; a
 * broader set would wrongly block documents and artifacts.
 */
const SOURCE_CODE_EXTENSIONS = new Set([
  ".c",
  ".cpp",
  ".go",
  ".h",
  ".java",
  ".js",
  ".jsx",
  ".py",
  ".rs",
  ".sh",
  ".ts",
  ".tsx",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
]);

/** True when `target`'s extension is classified as source code. */
export function isSourceCodeTarget(target: string): boolean {
  return SOURCE_CODE_EXTENSIONS.has(extname(target).toLowerCase());
}

/** Line count of `content` for copy-out review (newline-delimited). */
export function countCopyLines(content: string): number {
  return content.split("\n").length;
}

/**
 * Reject a source-code copy target whose line count exceeds the reviewable
 * limit (maxApplyDiffLines). Non-source targets are never rejected here: they
 * remain transferable regardless of size.
 */
export function assertCopyOutReviewLimit(
  target: string,
  totalLines: number,
  maxApplyDiffLines: number,
): void {
  if (!isSourceCodeTarget(target) || totalLines <= maxApplyDiffLines) return;
  throw new ValidationError(
    `source-code copy target exceeds the reviewable line limit (${totalLines} lines > ${maxApplyDiffLines} maxApplyDiffLines); ` +
      "large code changes must use sandbox_apply or be split into smaller copies",
  );
}
