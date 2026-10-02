/**
 * External-lens lineage registry (odd/tasks/external-advisors.md A3b/A4).
 *
 * A review lineage started WITHOUT a runtime agent asks gentle-ai for reviewer
 * results as files, which is how external advisors take part. The broker
 * records such lineages here (A4's reviewStart with externalLenses), and only
 * a recorded lineage may carry review-lens advisory requests or, later,
 * stored-response relays. Markers are empty private files under
 * <stateDir>/advisor/<projectId>/external-lineages/, created exclusively.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpContext } from "./service.ts";
import { ValidationError } from "./validation.ts";

const LINEAGE_RE = /^review-[A-Za-z0-9]{1,64}$/;
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function lineagesDir(ctx: Pick<OpContext, "config">, projectId: string): string {
  if (!PROJECT_ID_RE.test(projectId)) throw new ValidationError("invalid project id");
  const dir = join(ctx.config.stateDir, "advisor", projectId, "external-lineages");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const p of [join(ctx.config.stateDir, "advisor"), join(ctx.config.stateDir, "advisor", projectId), dir]) {
    chmodSync(p, 0o700);
  }
  return dir;
}

function assertLineage(lineage: unknown): string {
  if (typeof lineage !== "string" || !LINEAGE_RE.test(lineage)) {
    throw new ValidationError(`review lineage must match ${LINEAGE_RE}`);
  }
  return lineage;
}

/** Record a lineage as external-lens. Idempotent. */
export function markExternalLensLineage(ctx: Pick<OpContext, "config">, projectId: string, lineage: string): void {
  const path = join(lineagesDir(ctx, projectId), assertLineage(lineage));
  try {
    writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

export function isExternalLensLineage(ctx: Pick<OpContext, "config">, projectId: string, lineage: string): boolean {
  return existsSync(join(lineagesDir(ctx, projectId), assertLineage(lineage)));
}
