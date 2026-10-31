import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * scripts/start-openchamber-v2: attach OpenChamber 2 to the secured V2 server. Every refusal is executed against fake
 * `ss`, `ps` and OpenChamber binaries, so no real server or process table is involved.
 */
const ROOT = resolve(import.meta.dir, "../..");
const LAUNCHER = join(ROOT, "scripts/start-openchamber-v2");
const SECRET = "OCSECRET-do-not-log-4d1e";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "v2-oc-launch-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function script(path: string, body: string) {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

interface Options {
  version?: string; noBinary?: boolean; v1Binary?: boolean; passwordMode?: number; noPassword?: boolean; emptyPassword?: boolean;
  listeners?: number[]; chain?: Record<number, [number, string]>;
}

function setup(name: string, o: Options = {}) {
  const home = join(scratch, name);
  const v2root = join(home, ".local/share/opencode-v2");
  mkdirSync(join(v2root, "openchamber/node_modules/.bin"), { recursive: true });
  const bin = join(v2root, "openchamber/node_modules/.bin/openchamber");
  const log = join(home, "oc.log");
  const v1 = join(home, ".bun/bin/openchamber");
  mkdirSync(join(home, ".bun/bin"), { recursive: true });
  script(v1, `echo 1.24.2`);
  if (!o.noBinary) {
    script(bin, `if [ "\${1:-}" = "--version" ]; then echo ${o.version ?? "2.5.3"}; exit 0; fi
{ echo "ARGS:$*"; echo "SKIP:$OPENCODE_SKIP_START"; echo "HOST:$OPENCODE_HOST"; echo "PORT:$OPENCODE_PORT"; echo "HASPW:\${OPENCODE_SERVER_PASSWORD:+yes}"; echo "PWMATCH:$([ "$OPENCODE_SERVER_PASSWORD" = "${SECRET}" ] && echo yes)"; } >> "${log}"`);
  }
  if (!o.noPassword) {
    writeFileSync(join(v2root, "server-password"), o.emptyPassword ? "\n" : `${SECRET}\n`);
    chmodSync(join(v2root, "server-password"), o.passwordMode ?? 0o600);
  }
  const listeners = o.listeners ?? [4242];
  const chain = o.chain ?? { 4242: [4000, "env"], 4000: [3900, "nono"], 3900: [1, "systemd"] };
  script(join(home, "ss"), `echo "State Recv-Q Send-Q Local Peer Process"; ${listeners.map((p) => `echo 'LISTEN 0 511 127.0.0.1:4097 0.0.0.0:* users:(("opencode.exe",pid=${p},fd=20))'`).join("; ")}`);
  const rows = Object.entries(chain).map(([pid, [ppid, comm]]) => `${pid} ${ppid} ${comm}`).join("\n");
  script(join(home, "ps"), `table='${rows}'
pid="\${@: -1}"; line=$(echo "$table" | awk -v p="$pid" '$1==p')
case "$*" in *ppid=*) echo "$line" | awk '{print $2}' ;; *comm=*) echo "$line" | awk '{print $3}' ;; esac`);
  const env = { HOME: home, PATH: process.env.PATH ?? "", OPENCHAMBER_V2_BIN: v1Binary(o, bin, v1), SS_BIN: join(home, "ss"), PS_BIN: join(home, "ps") };
  return { home, log, env };
}
const v1Binary = (o: Options, bin: string, v1: string) => (o.v1Binary ? v1 : bin);

function launch(s: ReturnType<typeof setup>, ...args: string[]) {
  const proc = Bun.spawnSync([LAUNCHER, ...args], { env: s.env, stdin: "ignore" });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe("start-openchamber-v2", () => {
  test("attaches in skip-start mode with the V2 host, port and password, and passes its arguments through", () => {
    const s = setup("ok");
    const r = launch(s, "serve", "--foreground", "--port", "8789");
    expect(r.code).toBe(0);
    const log = readFileSync(s.log, "utf8");
    expect(log).toContain("ARGS:serve --foreground --port 8789");
    expect(log).toContain("SKIP:true");
    expect(log).toContain("HOST:http://127.0.0.1:4097");
    expect(log).toContain("PORT:4097");
    expect(log).toContain("HASPW:yes");
    expect(log).toContain("PWMATCH:yes");
    expect(r.out).toContain("attaching OpenChamber 2.5.3");
  });

  test("never prints the server password", () => {
    const r = launch(setup("secret-hidden"), "serve");
    expect(r.out + r.err).not.toContain(SECRET);
  });

  test("refuses a missing, wrong-version or V1 OpenChamber (exit 4) before it looks at the server", () => {
    expect(launch(setup("nobin", { noBinary: true })).code).toBe(4);
    const old = launch(setup("v1ver", { version: "1.24.2" }));
    expect(old.code).toBe(4);
    expect(old.err).toContain("not 2.x");
    const v1 = launch(setup("v1path", { v1Binary: true }));
    expect(v1.code).toBe(4);
  });

  test("refuses a missing, empty or group/world-readable password file (exit 4)", () => {
    expect(launch(setup("nopw", { noPassword: true })).code).toBe(4);
    expect(launch(setup("emptypw", { emptyPassword: true })).err).toContain("is empty");
    const loose = launch(setup("loosepw", { passwordMode: 0o644 }));
    expect(loose.code).toBe(4);
    expect(loose.err).toContain("must be mode 600");
  });

  test("refuses when nothing, or more than one process, listens on the V2 port (exit 5)", () => {
    const none = launch(setup("nolistener", { listeners: [] }));
    expect(none.code).toBe(5);
    expect(none.err).toContain("start it first");
    const two = launch(setup("twolisteners", { listeners: [4242, 4343] }));
    expect(two.code).toBe(5);
    expect(two.err).toContain("more than one");
  });

  test("refuses a server that was not started under nono (exit 5), and never starts OpenChamber then", () => {
    const s = setup("nonono", { chain: { 4242: [4000, "env"], 4000: [3900, "bash"], 3900: [1, "systemd"] } });
    const r = launch(s, "serve");
    expect(r.code).toBe(5);
    expect(r.err).toContain("NOT started under nono");
    expect(() => readFileSync(s.log, "utf8")).toThrow(); // OpenChamber was never executed
  });
});

describe("the unit template", () => {
  const unit = readFileSync(join(ROOT, "docs/openchamber-secure-v2.service.template"), "utf8");
  test("replaces the V1 unit on the same port and depends on the V2 server", () => {
    expect(unit).toContain("Conflicts=openchamber-secure.service");
    expect(unit).toContain("Requires=secure-opencode-v2.service");
    expect(unit).toContain("start-openchamber-v2 serve --foreground --port 8789");
  });
  test("carries no secret and leaves the server password to the launcher", () => {
    expect(unit).not.toMatch(/OPENCODE_SERVER_PASSWORD\s*=/);
    expect(unit).not.toMatch(/PASSWORD=\S+/);
  });
});
