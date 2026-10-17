import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeReviewRange, readReviewSlice, REVIEW_SLICE_MAX_BYTES, ReviewRangeCapError, ReviewRangeRefError, ReviewSliceNotFoundError } from "../src/review-materialize.ts";
import { ReviewRunStore } from "../src/review-run.ts";

const roots: string[] = [];
const temporary = () => {
  const base = ["/var/tmp", process.env.HOME ?? ""].find((candidate) => {
    try {
      const real = realpathSync(candidate);
      accessSync(real, constants.W_OK);
      return real !== realpathSync(tmpdir()) && !real.startsWith(`${realpathSync(tmpdir())}/`);
    } catch { return false; }
  });
  if (!base) throw new Error("no writable test base outside $TMPDIR is available");
  const path = mkdtempSync(join(base, "review-materialize-"));
  roots.push(path);
  return path;
};
afterAll(() => roots.forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("review materialization", () => {
  test("rejects an unresolved ref and names it", async () => {
    const env = fixture();
    await expect(materializeReviewRange({ baseRef: "missing-ref-xyz" }, "owner", env.options)).rejects.toBeInstanceOf(ReviewRangeRefError);
  });

  test("returns only a bounded index and writes no project files", async () => {
    const env = fixture();
    const before = projectSnapshot(env.project);
    const index = await materializeReviewRange({ baseRef: env.base, headRef: env.head }, "owner", env.options);
    const after = projectSnapshot(env.project);
    expect(after).toEqual(before);
    expect(index.changedPaths).toEqual(["change.txt"]);
    expect(index.sliceCount).toBe(1);
    expect(index.slices[0]?.name).toBe("slice-0000.diff");
    expect(JSON.stringify(index).length).toBeLessThan(8192);
    expect(JSON.stringify(index)).not.toContain("diff --git");
  });

  test("preserves non-UTF-8 diff bytes and slices at byte-exact file boundaries", async () => {
    const env = fixture();
    const base = env.head;
    writeFileSync(join(env.project, "aaa-latin.txt"), Buffer.concat([Buffer.from([0x68]), Buffer.alloc(23_000, 0xe9), Buffer.from([0x0a])]));
    writeFileSync(join(env.project, "zzz-ascii.txt"), `${"z".repeat(23_000)}\n`);
    gitAt(env.project, ["add", "aaa-latin.txt", "zzz-ascii.txt"]);
    gitAt(env.project, ["commit", "-qm", "non-UTF-8 file"]);
    const head = gitAt(env.project, ["rev-parse", "HEAD"]);
    const expected = gitBytesAt(env.project, base, head);
    expect(expected.includes(Buffer.from([0xe9]))).toBe(true);

    const index = await materializeReviewRange({ baseRef: base, headRef: head }, "owner", env.options);
    const runDir = env.store.runDir("owner", index.runId);
    const published = readFileSync(join(runDir, "scope.diff"));
    expect(published.equals(expected)).toBe(true);

    const starts = byteSectionStarts(expected);
    expect(starts).toHaveLength(index.changedPaths.length);
    expect(index.sliceCount).toBe(starts.length);
    for (const [i, start] of starts.entries()) {
      const end = starts[i + 1]?.offset ?? expected.length;
      const section = expected.subarray(start.offset, end);
      const artifact = readFileSync(join(runDir, `slice-${String(i).padStart(4, "0")}.diff`));
      const indexed = index.slices[i]!;
      expect(start.path).toBe(index.changedPaths[i]);
      expect(artifact.equals(section)).toBe(true);
      expect(indexed.bytes).toBe(artifact.byteLength);
      expect(indexed.sha256).toBe(createHash("sha256").update(artifact).digest("hex"));
    }
  });

  test("rejects workspace mode rather than invoking an unsafe index/tree diff", async () => {
    const env = fixture();
    await expect(materializeReviewRange({ baseRef: env.base, mode: "workspace" }, "owner", env.options)).rejects.toThrow("not supported in this slice");
  });

  test("rejects a single real changed file larger than one slice", async () => {
    const env = fixture();
    writeFileSync(join(env.project, "too-many-lines.txt"), `${"line\n".repeat(1500)}end\n`);
    const git = (args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: env.project, env: { PATH: process.env.PATH ?? "" } });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    git(["add", "too-many-lines.txt"]);
    git(["commit", "-qm", "oversized file"]);
    const oversizedHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: env.project }).stdout.toString().trim();
    await expect(materializeReviewRange({ baseRef: env.base, headRef: oversizedHead }, "owner", env.options)).rejects.toThrow("too-many-lines.txt");
  });

  test("rejects a git response that is not a full lowercase object id", async () => {
    const env = fixture();
    const invalid = async () => ({ status: 0, stdout: "HEAD\n", stderr: "", timedOut: false });
    await expect(materializeReviewRange({ baseRef: "HEAD" }, "owner", { ...env.options, spawn: invalid as never })).rejects.toThrow("invalid object id");
  });

  test("refuses a realized range above the configured per-run byte cap", async () => {
    const env = fixture();
    env.store.caps.maxBytes = 100;
    await expect(materializeReviewRange({ baseRef: env.base, headRef: env.head }, "owner", env.options)).rejects.toBeInstanceOf(ReviewRangeCapError);
  });

  test("packs two-file ranges at exactly 1500 realized diff lines, then splits at 1501", async () => {
    const env = fixture();
    const base = env.head;
    writeFileSync(join(env.project, "boundary-a.txt"), `${"a\n".repeat(900)}`);
    writeFileSync(join(env.project, "boundary-b.txt"), "b\n");
    gitAt(env.project, ["add", "boundary-a.txt", "boundary-b.txt"]);
    gitAt(env.project, ["commit", "-qm", "line boundary seed"]);
    let head = gitAt(env.project, ["rev-parse", "HEAD"]);
    let diff = diffAt(env.project, base, head);
    let realizedLines = diffLineCount(diff);
    const initialB = 1;
    const addLines = 1500 - realizedLines;
    writeFileSync(join(env.project, "boundary-b.txt"), `${"b\n".repeat(initialB + addLines)}`);
    gitAt(env.project, ["add", "boundary-b.txt"]);
    gitAt(env.project, ["commit", "-qm", "exact line boundary"]);
    head = gitAt(env.project, ["rev-parse", "HEAD"]);
    diff = diffAt(env.project, base, head);
    realizedLines = diffLineCount(diff);
    expect(realizedLines).toBe(1500);
    const exact = await materializeReviewRange({ baseRef: base, headRef: head }, "owner", env.options);
    expect(exact.sliceCount).toBe(1);

    writeFileSync(join(env.project, "boundary-b.txt"), `${"b\n".repeat(initialB + addLines + 1)}`);
    gitAt(env.project, ["add", "boundary-b.txt"]);
    gitAt(env.project, ["commit", "-qm", "one line over boundary"]);
    head = gitAt(env.project, ["rev-parse", "HEAD"]);
    diff = diffAt(env.project, base, head);
    realizedLines = diffLineCount(diff);
    expect(realizedLines).toBe(1501);
    const over = await materializeReviewRange({ baseRef: base, headRef: head }, "owner", env.options);
    expect(over.sliceCount).toBe(2);
    expect(diffPaths(readFileSync(join(env.store.runDir("owner", over.runId), "slice-0000.diff"), "utf8")).length).toBeGreaterThan(0);
  });

  test("accepts one real file section exactly 46080 realized bytes", async () => {
    const env = fixture();
    const base = env.head;
    const path = join(env.project, "byte-boundary.txt");
    writeFileSync(path, "x\n");
    gitAt(env.project, ["add", "byte-boundary.txt"]);
    gitAt(env.project, ["commit", "-qm", "byte boundary seed"]);
    let head = gitAt(env.project, ["rev-parse", "HEAD"]);
    let diff = diffAt(env.project, base, head);
    let sectionBytes = Buffer.byteLength(diff);
    const payloadBytes = REVIEW_SLICE_MAX_BYTES - sectionBytes + 1;
    writeFileSync(path, `${"x".repeat(payloadBytes)}\n`);
    gitAt(env.project, ["add", "byte-boundary.txt"]);
    gitAt(env.project, ["commit", "-qm", "exact byte boundary"]);
    head = gitAt(env.project, ["rev-parse", "HEAD"]);
    diff = diffAt(env.project, base, head);
    sectionBytes = Buffer.byteLength(diff);
    expect(sectionBytes).toBe(46080);
    const index = await materializeReviewRange({ baseRef: base, headRef: head }, "owner", env.options);
    expect(index.sliceCount).toBe(1);
    expect(index.slices[0]?.bytes).toBe(46080);
  });

  test("splits two individually-fitting file sections whose realized sum exceeds 46080 bytes", async () => {
    const env = fixture();
    const base = env.head;
    const a = "A".repeat(23_000);
    const b = "B".repeat(23_000);
    writeFileSync(join(env.project, "split-a.txt"), `${a}\n`);
    writeFileSync(join(env.project, "split-b.txt"), `${b}\n`);
    gitAt(env.project, ["add", "split-a.txt", "split-b.txt"]);
    gitAt(env.project, ["commit", "-qm", "two-file byte boundary"]);
    const head = gitAt(env.project, ["rev-parse", "HEAD"]);
    const diff = diffAt(env.project, base, head);
    const sections = diffSections(diff);
    expect(sections.map((section) => section.bytes)).toEqual([23131, 23131]);
    expect(sections.every((section) => section.bytes < 46080)).toBe(true);
    expect(sections.reduce((sum, section) => sum + section.bytes, 0)).toBe(46262);
    const index = await materializeReviewRange({ baseRef: base, headRef: head }, "owner", env.options);
    expect(index.changedPaths).toEqual(sections.map((section) => section.path));
    expect(index.sliceCount).toBe(2);
    const runDir = env.store.runDir("owner", index.runId);
    for (const [i, section] of sections.entries()) {
      const name = `slice-${String(i).padStart(4, "0")}.diff`;
      const artifact = readFileSync(join(runDir, name));
      const indexed = index.slices[i]!;
      expect(diffPaths(artifact.toString("utf8"))).toEqual([section.path]);
      expect(indexed.name).toBe(name);
      expect(indexed.bytes).toBe(artifact.byteLength);
      expect(indexed.sha256).toBe(createHash("sha256").update(artifact).digest("hex"));
      expect(artifact.equals(Buffer.from(section.text))).toBe(true);
    }
  });

  test("rejects exhausted session quota before invoking Git", async () => {
    const env = fixture();
    env.store.caps.maxPerSession = 1;
    const prior = env.store.createRun("owner", { baseObjectId: env.base, headObjectId: env.head });
    prior.publish();
    let spawnCount = 0;
    const spawn = async () => { spawnCount += 1; throw new Error("Git must not run"); };
    const result = await materializeReviewRange({ baseRef: env.base }, "owner", { ...env.options, spawn: spawn as never })
      .then(() => null, (error: unknown) => error);
    expect(spawnCount).toBe(0);
    expect(result).toMatchObject({ code: "review_run_quota" });
  });

  test("refuses to serve artifacts from a failed run", async () => {
    const env = fixture();
    const writer = env.store.createRun("failedowner", { baseObjectId: env.base, headObjectId: env.head });
    writer.addArtifact("slice-0000.diff", "private diff");
    writer.fail();
    await expect(readReviewSlice(writer.record.runId, "slice-0000.diff", "failedowner", { store: env.store }))
      .rejects.toMatchObject({ code: "review_run_not_published" });
  });

  test("serves a slice only to the owning session and refuses missing or oversized slices", async () => {
    const env = fixture();
    const index = await materializeReviewRange({ baseRef: env.base, headRef: env.head }, "owner", env.options);
    await expect(readReviewSlice(index.runId, "slice-0000.diff", "intruder", { store: env.store })).rejects.toThrow("not owned");
    await expect(readReviewSlice(index.runId, "slice-9999.diff", "owner", { store: env.store })).rejects.toBeInstanceOf(ReviewSliceNotFoundError);
    const writer = env.store.createRun("largeowner", { baseObjectId: env.base, headObjectId: env.head });
    writer.addArtifact("slice-0000.diff", Buffer.alloc(64 * 1024 + 1, 0x61));
    writer.publish();
    await expect(readReviewSlice(writer.record.runId, "slice-0000.diff", "largeowner", { store: env.store })).rejects.toThrow("read cap");
  });
});

function gitAt(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function diffAt(root: string, base: string, head: string): string {
  const result = Bun.spawnSync(["git", "diff", "--no-ext-diff", "--no-color", "--no-textconv", "-U3", base, head, "--"], { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

function gitBytesAt(root: string, base: string, head: string): Buffer {
  const result = Bun.spawnSync(["git", "diff", "--no-ext-diff", "--no-color", "--no-textconv", "-U3", base, head, "--"], { cwd: root, env: { PATH: process.env.PATH ?? "" } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}

function byteSectionStarts(diff: Buffer): { offset: number; path: string }[] {
  const view = diff.toString("latin1");
  const starts: { offset: number; path: string }[] = [];
  const marker = /^diff --git a\/(.+?) b\/.+$/gm;
  for (let match = marker.exec(view); match; match = marker.exec(view)) starts.push({ offset: match.index, path: match[1]! });
  return starts;
}

function diffLineCount(diff: string): number {
  return diff.split("\n").length - (diff.endsWith("\n") ? 1 : 0);
}

function diffSections(diff: string): { path: string; text: string; bytes: number }[] {
  if (!diff) return [];
  const starts = [...diff.matchAll(/^diff --git a\/(.+?) b\/.+$/gm)].map((match) => ({ index: match.index!, path: match[1]! }));
  return starts.map((start, index) => {
    const end = starts[index + 1]?.index ?? diff.length;
    const text = diff.slice(start.index, end);
    return { path: start.path, text, bytes: Buffer.byteLength(text) };
  });
}

function diffPaths(diff: string): string[] {
  return [...diff.matchAll(/^diff --git a\/(.+?) b\/.+$/gm)].map((match) => match[1]!);
}

function projectSnapshot(root: string): unknown[] {
  const entries: unknown[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = statSync(path);
      const relative = path.slice(root.length + 1);
      entries.push({ path: relative, bytes: stat.isFile() ? stat.size : 0, mtimeMs: stat.mtimeMs, directory: stat.isDirectory() });
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(root);
  return entries;
}

function fixture() {
  const root = temporary();
  const project = join(root, "project");
  const storeRoot = join(root, "store");
  mkdirSync(project);
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: project, env: { PATH: process.env.PATH ?? "" } });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(project, "base.txt"), "base\n");
  git(["add", "base.txt"]);
  git(["commit", "-qm", "base"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(join(project, "change.txt"), "change\n");
  git(["add", "change.txt"]);
  git(["commit", "-qm", "change"]);
  const head = git(["rev-parse", "HEAD"]);
  const store = new ReviewRunStore({ root: storeRoot, projectRoot: project });
  return { project, storeRoot, store, base, head, options: { projectRoot: project, storeRoot, store } };
}
