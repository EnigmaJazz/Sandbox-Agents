import { describe, expect, test } from "bun:test";
import {
  assertCopyOutReviewLimit,
  countCopyLines,
  isSourceCodeTarget,
} from "../src/copy-review.ts";

const SOURCE_EXTENSIONS = [
  ".ts",
  ".js",
  ".tsx",
  ".jsx",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".sh",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
];

describe("copy-out review: source-code classifier", () => {
  test("classifies every listed source-code extension as source code", () => {
    for (const ext of SOURCE_EXTENSIONS) {
      expect(isSourceCodeTarget(`/review/file${ext}`)).toBe(true);
    }
  });

  test("does not classify documents and artifacts as source code", () => {
    for (const file of [
      "/review/README.md",
      "/review/notes.txt",
      "/review/app.log",
      "/review/fig.pdf",
      "/review/icon.png",
      "/review/photo.jpg",
    ]) {
      expect(isSourceCodeTarget(file)).toBe(false);
    }
  });

  test("matches extensions case-insensitively", () => {
    expect(isSourceCodeTarget("/review/Service.TS")).toBe(true);
    expect(isSourceCodeTarget("/review/Config.JSON")).toBe(true);
    expect(isSourceCodeTarget("/review/Config.YAML")).toBe(true);
  });

  test("files without a listed extension are not source code", () => {
    expect(isSourceCodeTarget("/review/LICENSE")).toBe(false);
    expect(isSourceCodeTarget("/review/Makefile")).toBe(false);
    expect(isSourceCodeTarget("/review/notes.rst")).toBe(false);
  });
});

describe("copy-out review: line-limit gate", () => {
  test("rejects source-code targets over maxApplyDiffLines", () => {
    expect(() => assertCopyOutReviewLimit("/review/service.ts", 201, 200)).toThrow(
      /reviewable line limit/,
    );
  });

  test("accepts source-code targets at or below maxApplyDiffLines", () => {
    expect(() => assertCopyOutReviewLimit("/review/service.ts", 200, 200)).not.toThrow();
    expect(() => assertCopyOutReviewLimit("/review/service.ts", 199, 200)).not.toThrow();
  });

  test("accepts source-code targets when the configured cap is higher", () => {
    expect(() => assertCopyOutReviewLimit("/review/service.ts", 1500, 2000)).not.toThrow();
  });

  test("never rejects non-source targets regardless of size", () => {
    expect(() => assertCopyOutReviewLimit("/review/big.md", 10000, 200)).not.toThrow();
    expect(() => assertCopyOutReviewLimit("/review/app.log", 10000, 200)).not.toThrow();
    expect(() => assertCopyOutReviewLimit("/review/big.pdf", 10000, 200)).not.toThrow();
  });
});

describe("copy-out review: line counting", () => {
  test("counts newline-delimited lines", () => {
    expect(countCopyLines("")).toBe(1);
    expect(countCopyLines("a\nb")).toBe(2);
    expect(countCopyLines("a\nb\nc")).toBe(3);
  });
});
