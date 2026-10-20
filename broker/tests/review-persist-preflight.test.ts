import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightReviewPersist } from "../src/review-persist.ts";
import { ReviewRunStore } from "../src/review-run.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(document: Record<string, unknown> = { kind: "writing", artifact: { findings_count: 2, findings: [], verdict: "pass", nested: { hidden_count: 99 } } }) {
  const projectDir = mkdtempSync(join(tmpdir(), "review-preflight-project-"));
  const storeRoot = mkdtempSync(join(process.cwd(), "..", "review-preflight-store-"));
  roots.push(projectDir, storeRoot);
  const sessionID = "preflight-session";
  const store = new ReviewRunStore({ root: storeRoot, projectRoot: projectDir });
  const writer = store.createRun(sessionID, { baseObjectId: "a".repeat(40), headObjectId: "b".repeat(40) });
  const runId = writer.record.runId;
  const body = JSON.stringify(document);
  const artifact = writer.addArtifact("phase-finalize.json", body);
  writer.publish();
  store.recordFinalizeProvenance(sessionID, runId, { phase: "finalize", outcome: "accepted", artifact, inputSource: "stdin" });
  return { projectDir, store, storeRoot, sessionID, runId, artifact, body };
}

test("preflight returns bounded broker-derived facts for an accepted writing artifact without writes", async () => {
  const f = fixture();
  const snapshot = (path: string): string => readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => entry.isDirectory() ? `${entry.name}/${snapshot(join(path, entry.name))}` : `${entry.name}:${readFileSync(join(path, entry.name)).toString("hex")}`).join("|");
  const beforeProject = snapshot(f.projectDir);
  const beforeStore = snapshot(f.storeRoot);
  const readOnlyStore = ReviewRunStore.readOnly({ root: f.storeRoot, projectRoot: f.projectDir, caps: f.store.caps });
  expect(snapshot(f.storeRoot)).toBe(beforeStore);
  const result = await preflightReviewPersist({ projectDir: f.projectDir, runId: f.runId, finalizeRef: "phase-finalize.json", store: readOnlyStore, sessionID: f.sessionID, maxFileBytes: 1024 * 1024 });
  expect(result).toMatchObject({
    runId: f.runId, projectDir: f.projectDir, baseObjectId: "a".repeat(40), headObjectId: "b".repeat(40),
    changedPaths: 0, totalBytes: 0,
    finalize: { name: f.artifact.name, bytes: f.artifact.bytes, sha256: createHash("sha256").update(f.body).digest("hex") },
    finalizeInput: "stdin", kind: "writing", verdict: "pass", verdictSource: "verdict",
    counts: { findings_count: 2, findings: 0 }, blockers: [],
  });
  expect(result.counts).not.toHaveProperty("hidden_count");
  expect(snapshot(f.projectDir)).toBe(beforeProject);
  expect(snapshot(f.storeRoot)).toBe(beforeStore);
  expect(readdirSync(f.projectDir)).not.toContain(".context");
  expect(readdirSync(f.storeRoot)).not.toContain("staging");
});

 test("legacy finalize records default input source to unknown", async () => {
  const f = fixture();
  const record = f.store.readRecord(f.sessionID, f.runId);
  delete record.finalizeProvenance!.inputSource;
  writeFileSync(join(f.store.runDir(f.sessionID, f.runId), "metadata.json"), `${JSON.stringify(record)}\n`);
  const result = await preflightReviewPersist({ projectDir: f.projectDir, runId: f.runId, finalizeRef: "phase-finalize.json", store: f.store, sessionID: f.sessionID, maxFileBytes: 1024 * 1024 });
  expect(result.finalizeInput).toBe("unknown");
});

test("preflight accumulates the persist-equivalent reference and kind blockers", async () => {
  const f = fixture({ kind: "report", artifact: { findings: [] } });
  const result = await preflightReviewPersist({ projectDir: f.projectDir, runId: f.runId, finalizeRef: "other.json", store: f.store, sessionID: f.sessionID, maxFileBytes: 1024 * 1024 });
  expect(result.blockers.map((blocker) => blocker.code)).toEqual(["review_persist_finalize_ref_mismatch", "review_persist_kind"]);
});

test("preflight reports schema-tolerant bounded top-level counts and verdict source", async () => {
  const lists = Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`list_${index}`, [index]]));
  const f = fixture({ kind: "writing", artifact: { plan_assessment: { verdict: "review" }, item_count: 7, nested: { hidden_count: 8 }, ...lists } });
  const result = await preflightReviewPersist({ projectDir: f.projectDir, runId: f.runId, finalizeRef: "phase-finalize.json", store: f.store, sessionID: f.sessionID, maxFileBytes: 1024 * 1024 });
  expect(result.verdict).toBe("review");
  expect(result.verdictSource).toBe("plan_assessment.verdict");
  expect(Object.keys(result.counts)).toHaveLength(16);
  expect(result.counts).toHaveProperty("item_count", 7);
  expect(result.counts).not.toHaveProperty("hidden_count");
  const absent = fixture({ kind: "writing", artifact: { findings: [] } });
  const noVerdict = await preflightReviewPersist({ projectDir: absent.projectDir, runId: absent.runId, finalizeRef: absent.artifact.name, store: absent.store, sessionID: absent.sessionID, maxFileBytes: 1024 * 1024 });
  expect(noVerdict.verdict).toBeNull();
  expect(noVerdict.verdictSource).toBeNull();
});

test("preflight reports project and finalize provenance blockers with persist codes",  async () => {
  const f = fixture();
  const otherProject = mkdtempSync(join(tmpdir(), "review-preflight-other-project-"));
  roots.push(otherProject);
  const mismatch = await preflightReviewPersist({ projectDir: otherProject, runId: f.runId, finalizeRef: "phase-finalize.json", store: f.store, sessionID: f.sessionID, maxFileBytes: 1024 * 1024 });
  expect(mismatch.blockers.map((item) => item.code)).toContain("review_persist_project_mismatch");
  const record = f.store.readRecord(f.sessionID, f.runId);
  record.finalizeProvenance!.phase = "prepare" as never;
  record.finalizeProvenance!.outcome = "structurally_rejected";
  writeFileSync(join(f.store.runDir(f.sessionID, f.runId), "metadata.json"), `${JSON.stringify(record)}\n`);
  const invalid = await preflightReviewPersist({ projectDir: f.projectDir, runId: f.runId, finalizeRef: "phase-finalize.json", store: f.store, sessionID: f.sessionID, maxFileBytes: 1024 * 1024 });
  expect(invalid.blockers.map((item) => item.code)).toEqual(["review_persist_finalize_phase_invalid", "review_persist_finalize_outcome_invalid"]);
  record.finalizeProvenance!.phase = "finalize";
  record.finalizeProvenance!.outcome = "accepted";
  delete record.finalizeProvenance!.artifact;
  writeFileSync(join(f.store.runDir(f.sessionID, f.runId), "metadata.json"), `${JSON.stringify(record)}\n`);
  const noArtifact = await preflightReviewPersist({ projectDir: f.projectDir, runId: f.runId, finalizeRef: "phase-finalize.json", store: f.store, sessionID: f.sessionID, maxFileBytes: 1024 * 1024 });
  expect(noArtifact.blockers.map((item) => item.code)).toEqual(["review_persist_finalize_provenance_missing"]);
  delete record.finalizeProvenance;
  writeFileSync(join(f.store.runDir(f.sessionID, f.runId), "metadata.json"), `${JSON.stringify(record)}\n`);
  const missing = await preflightReviewPersist({ projectDir: f.projectDir, runId: f.runId, finalizeRef: "phase-finalize.json", store: f.store, sessionID: f.sessionID, maxFileBytes: 1024 * 1024 });
  expect(missing.blockers.map((item) => item.code)).toEqual(["review_persist_finalize_provenance_missing"]);
});

test("preflight reports unreadable artifact and malformed writing wrapper blockers", async () => {
  const unreadable = fixture();
  rmSync(join(unreadable.store.runDir(unreadable.sessionID, unreadable.runId), unreadable.artifact.name));
  const missingBytes = await preflightReviewPersist({ projectDir: unreadable.projectDir, runId: unreadable.runId, finalizeRef: unreadable.artifact.name, store: unreadable.store, sessionID: unreadable.sessionID, maxFileBytes: 1024 * 1024 });
  expect(missingBytes.blockers.map((item) => item.code)).toEqual(["review_persist_preflight_artifact_unreadable"]);
  const noBody = fixture({ kind: "writing" });
  const malformed = await preflightReviewPersist({ projectDir: noBody.projectDir, runId: noBody.runId, finalizeRef: noBody.artifact.name, store: noBody.store, sessionID: noBody.sessionID, maxFileBytes: 1024 * 1024 });
  expect(malformed.blockers.map((item) => item.code)).toEqual(["review_persist_artifact"]);
});

test("preflight reports digest and invalid-JSON blockers", async () => {
  const f = fixture();
  writeFileSync(join(f.store.runDir(f.sessionID, f.runId), f.artifact.name), "{");
  const result = await preflightReviewPersist({ projectDir: f.projectDir, runId: f.runId, finalizeRef: f.artifact.name, store: f.store, sessionID: f.sessionID, maxFileBytes: 1024 * 1024 });
  expect(result.blockers.map((item) => item.code)).toEqual(["review_persist_finalize_digest_mismatch", "review_persist_preflight_json_invalid"]);
});

test("preflight refuses another session's run instead of returning blockers", async () => {
  const f = fixture();
  await expect(Promise.resolve().then(() => preflightReviewPersist({ projectDir: f.projectDir, runId: f.runId, finalizeRef: "phase-finalize.json", store: f.store, sessionID: "other-session", maxFileBytes: 1024 * 1024 }))).rejects.toThrow();
});
