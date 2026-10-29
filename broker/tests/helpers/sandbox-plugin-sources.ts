import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PLUGINS_DIR = resolve(import.meta.dir, "../../../opencode/plugins");

/**
 * Source text of the sandbox plugin. P0 (docs/upgrades/opencode-v2.md) splits it into the V1 adapter
 * (sandbox-tools.ts), the host-neutral runtime (lib/tool-runtime.ts) and the tool tables
 * (lib/tool-specs-*.ts); source-shape tests read all of them as one text.
 */
export function sandboxPluginSources(): string {
  const libFiles = readdirSync(resolve(PLUGINS_DIR, "lib"))
    .filter((name) => name === "tool-runtime.ts" || /^tool-specs-.*\.ts$/.test(name))
    .sort()
    .map((name) => `lib/${name}`);
  return ["sandbox-tools.ts", ...libFiles]
    .map((file) => readFileSync(resolve(PLUGINS_DIR, file), "utf8"))
    .join("\n");
}
