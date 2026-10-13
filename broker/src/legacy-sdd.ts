/**
 * Legacy SDD dormancy (gentle-ai 4 pre-upgrade, docs/upgrades/gentle-ai-4.md).
 *
 * gentle-ai 4.0.0 removed the `sdd-*` subcommands. The five broker SDD
 * operations stay registered and fully implemented so a rollback to 3.x is
 * configuration only, but they refuse unless legacy SDD resolved as enabled.
 *
 * BROKER_LEGACY_SDD selects the mode:
 * - `auto` (default): enabled only when `gentle-ai --version` reports a major
 *   version below 4; an unreadable version fails closed (disabled).
 * - `on` / `off`: explicit, for rollback or testing; a mismatch with the
 *   detected version is logged as a warning, never silently corrected.
 *
 * Review operations share sdd-runtime.ts / sdd-service.ts and are never gated.
 */
import { PolicyError } from "./policy.ts";
import type { SpawnFn } from "./msb.ts";
import { ValidationError } from "./validation.ts";

export type LegacySddMode = "auto" | "on" | "off";

/** The broker operations that invoke retired `gentle-ai sdd-*` subcommands. */
export const LEGACY_SDD_OPERATIONS: ReadonlySet<string> = new Set([
  "sddStatus",
  "sddContinue",
  "sddTaskResult",
  "sddAttemptGrant",
  "sddArchiveCompose",
]);

/** First gentle-ai major version without the `sdd-*` subcommands. */
const SDD_RETIRED_MAJOR = 4;

export const LEGACY_SDD_DORMANT_MESSAGE =
  "SDD retired in gentle-ai 4; this operation is dormant. " +
  "Enable it only after rolling back to gentle-ai 3.x (BROKER_LEGACY_SDD=on or auto with a 3.x binary).";

export function parseLegacySddMode(raw: string | undefined): LegacySddMode {
  if (raw === undefined || raw === "") return "auto";
  if (raw === "auto" || raw === "on" || raw === "off") return raw;
  throw new ValidationError(`BROKER_LEGACY_SDD must be auto, on or off, got ${JSON.stringify(raw)}`);
}

/** Major version from `gentle-ai --version` output, or null when unreadable. */
export function parseGentleAiMajor(output: string): number | null {
  const m = /gentle-ai\s+v?(\d+)\.\d+\.\d+/.exec(output);
  return m ? Number(m[1]) : null;
}

export interface LegacySddResolution {
  enabled: boolean;
  /** Set when the outcome deserves the operator's attention. */
  warning?: string;
}

export function resolveLegacySdd(mode: LegacySddMode, major: number | null): LegacySddResolution {
  if (mode === "on") {
    return major !== null && major >= SDD_RETIRED_MAJOR
      ? { enabled: true, warning: `BROKER_LEGACY_SDD=on but gentle-ai ${major} has no sdd-* subcommands; SDD calls will fail` }
      : { enabled: true };
  }
  if (mode === "off") {
    return major !== null && major < SDD_RETIRED_MAJOR
      ? { enabled: false, warning: `BROKER_LEGACY_SDD=off with gentle-ai ${major}; SDD operations are dormant although the binary supports them` }
      : { enabled: false };
  }
  if (major === null) {
    return { enabled: false, warning: "gentle-ai version could not be determined; legacy SDD stays dormant (fail closed)" };
  }
  return { enabled: major < SDD_RETIRED_MAJOR };
}

/** Run `<binary> --version` once; any failure yields null (fail closed in auto). */
export async function detectGentleAiMajor(binary: string, spawn: SpawnFn): Promise<number | null> {
  try {
    const res = await spawn([binary, "--version"], { timeoutMs: 10_000, maxOutputBytes: 4096 });
    if (res.status !== 0 || res.timedOut) return null;
    return parseGentleAiMajor(res.stdout);
  } catch {
    return null;
  }
}

/** Refuse a legacy SDD operation unless the broker resolved SDD as enabled. */
export function assertLegacySddEnabled(config: { sddRuntime: { legacySddEnabled: boolean } }): void {
  if (!config.sddRuntime.legacySddEnabled) {
    throw new PolicyError(LEGACY_SDD_DORMANT_MESSAGE);
  }
}
