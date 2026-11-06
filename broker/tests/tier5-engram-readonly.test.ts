import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** S93 (D23): no fragment grants Tier 5 an Engram mutation capability, directly or by wildcard. */
const ROOT = resolve(import.meta.dir, "../..");
const DIRS = [resolve(ROOT, "opencode/config-fragments"), resolve(ROOT, "opencode/plugins-v2/config-fragments")];

const MUTATIONS = [
  "mem_save", "mem_update", "mem_delete", "mem_session_start", "mem_session_end", "mem_session_summary",
  "mem_capture_passive", "mem_save_prompt", "mem_judge", "mem_judge_many", "mem_pin", "mem_unpin",
  "mem_consolidate", "mem_suggest_topic_key",
];
const NAMES = MUTATIONS.flatMap((m) => [m, `engram_${m}`, `plugin_engram_engram_${m}`, `engram_engram_${m}`]);

function parseJsonc(text: string): unknown {
  return JSON.parse(text.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n"));
}
const globRe = (g: string) => new RegExp(`^${g.replace(/[\\^$.|?+()[\]{}]/g, "\\$&").replace(/\*+/g, ".*")}$`);
const covers = (key: string) => NAMES.some((n) => globRe(key).test(n));
const granting = (v: unknown) => v === "allow" || v === "ask" || v === true;

/** Every key (or allow-list entry) that grants and covers an Engram mutation name. */
function violations(node: unknown, path = ""): string[] {
  if (Array.isArray(node)) return [];
  if (typeof node !== "object" || node === null) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(node)) {
    const here = `${path}/${k}`;
    if (k === "allow" && Array.isArray(v)) out.push(...v.filter((e) => typeof e === "string" && covers(e)).map((e) => `${here}:${e}`));
    else if (granting(v) && covers(k)) out.push(here);
    else out.push(...violations(v, here));
  }
  return out;
}

describe("Tier 5 has no Engram mutation capability (S93)", () => {
  const files = DIRS.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".jsonc")).map((f) => resolve(d, f)));

  test("fragments are found", () => expect(files.length).toBeGreaterThanOrEqual(6));
  for (const f of files)
    test(`no Engram mutation grant in ${f.slice(ROOT.length + 1)}`, () => {
      expect(violations(parseJsonc(readFileSync(f, "utf8")))).toEqual([]);
    });

  test("positive control: direct, prefixed, wildcard and allow-list grants are detected", () => {
    expect(violations({ permission: { mem_save: "allow" } })).toHaveLength(1);
    expect(violations({ permission: { engram_mem_delete: "ask" } })).toHaveLength(1);
    expect(violations({ tools: { "mem_*": true } })).toHaveLength(1);
    expect(violations({ permission: { "*": "allow" } })).toHaveLength(1);
    expect(violations({ permission: { "engram*": "allow" } })).toHaveLength(1);
    expect(violations({ permission: { read: { allow: ["mem_pin"] } } })).toHaveLength(1);
  });
  test("negative control: denies and unrelated allows are not flagged", () => {
    expect(violations({ permission: { mem_save: "deny", "*": "deny", sandbox_read: "allow", "bash *": "allow" }, tools: { "*": false } })).toEqual([]);
  });
});
