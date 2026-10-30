import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * V6 (docs/upgrades/opencode-v2.md): confinement and launch for the parallel V2 stack. Everything V1 uses stays
 * untouched: separate binary, XDG roots, port, nono profile, launcher and installer.
 */
const ROOT = resolve(import.meta.dir, "../..");
const V1_PROFILE = JSON.parse(readFileSync(join(ROOT, "nono/profile/opencode-secure.json"), "utf8"));
const V2_PROFILE_PATH = join(ROOT, "nono/profile/opencode-v2-secure.json");
const SECRET = "TESTSECRET-do-not-log-9f3a";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "v2-launch-test-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawnSync(cmd, { cwd: opts.cwd, env: { PATH: process.env.PATH ?? "", ...opts.env }, stdin: "ignore" });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

const grants = (profile: any): string[] => [
  ...(profile.filesystem?.allow ?? []),
  ...(profile.filesystem?.allow_file ?? []),
  ...(profile.filesystem?.read ?? []),
];

describe("V2 nono profile", () => {
  const v2 = JSON.parse(readFileSync(V2_PROFILE_PATH, "utf8"));

  test("has its own name and does not reuse the V1 profile name", () => {
    expect(v2.meta.name).toBe("opencode-v2-secure");
    expect(v2.meta.name).not.toBe(V1_PROFILE.meta.name);
  });

  test("grants none of the V1 roots (V1 and V2 must not share a config, data or cache root)", () => {
    const v1Roots = ["$HOME/.opencode", "$HOME/.local/share/opencode", "$HOME/.local/state/opencode", "$HOME/.cache/opencode", "$HOME/.config/opencode"];
    for (const grant of grants(v2)) expect(v1Roots).not.toContain(grant);
  });

  test("grants write access to the V2 data, state and cache roots and the control directory", () => {
    const writable = [...v2.filesystem.allow, ...(v2.filesystem.allow_file ?? [])];
    for (const root of ["data", "state", "cache"]) expect(writable).toContain(`$HOME/.local/share/opencode-v2/${root}`);
    expect(writable).toContain("$HOME/.local/share/opencode-sandbox-control");
  });

  test("the V2 config root, which holds the security plugins, is read-only for the confined agent", () => {
    // Landlock cannot carve a read-only subdirectory out of a writable grant (nono refuses a deny overlap), so the
    // whole config root is read-only: a prompt-injected agent cannot overwrite its own routing guard or fragments.
    const configRoot = "$HOME/.local/share/opencode-v2/config";
    const writable = [...v2.filesystem.allow, ...(v2.filesystem.allow_file ?? [])];
    expect(writable.filter((p: string) => p === configRoot || configRoot.startsWith(`${p}/`) || p.startsWith(`${configRoot}/`))).toEqual([]);
    expect(v2.filesystem.read).toContain(configRoot);
  });

  test("grants no write access to any project's .git directory (V2 never writes there; hooks planted there would run on the host)", () => {
    const writable = [...v2.filesystem.allow, ...(v2.filesystem.allow_file ?? [])];
    expect(writable.filter((p: string) => /(^|\/)\.git(\/|$)/.test(p))).toEqual([]);
    // positive control: the V1 profile does grant them, so this check can fail
    expect([...V1_PROFILE.filesystem.allow].filter((p: string) => /(^|\/)\.git(\/|$)/.test(p)).length).toBeGreaterThan(0);
    // reading them stays possible through the project-root read grants
    expect(v2.filesystem.read).toContain("$HOME/agent-sandbox-integration");
  });

  test("no writable grant covers the V2 root itself or any of its parents", () => {
    const v2root = "$HOME/.local/share/opencode-v2";
    const writable = [...v2.filesystem.allow, ...(v2.filesystem.allow_file ?? [])];
    for (const parent of ["$HOME", "$HOME/.local", "$HOME/.local/share", v2root]) expect(writable).not.toContain(parent);
  });

  test("denies the sources V2 would otherwise read: ~/.claude and ~/.agents", () => {
    expect(v2.filesystem.deny).toContain("$HOME/.claude");
    expect(v2.filesystem.deny).toContain("$HOME/.agents");
    expect(grants(v2).some((grant: string) => grant.includes("$HOME/.agents"))).toBe(false);
  });

  test("keeps every V1 credential-store denial", () => {
    for (const path of V1_PROFILE.filesystem.deny) expect(v2.filesystem.deny).toContain(path);
  });

  test("listens on the V2 port, never 4096", () => {
    expect(v2.network.listen_port).toEqual([4097]);
    expect(v2.network.open_port).toContain(4097);
    expect(v2.network.open_port).not.toContain(4096);
    expect(v2.network.listen_port).not.toContain(4096);
  });

  test("reaches the same hosts and project roots as V1, with the same isolation", () => {
    expect(v2.network.allow_domain).toEqual(V1_PROFILE.network.allow_domain);
    const v2Only = ["$HOME/.local/share/opencode-v2/prefix", "$HOME/.local/share/opencode-v2/config"];
    expect(v2.filesystem.read.filter((p: string) => !v2Only.includes(p)).sort()).toEqual(
      V1_PROFILE.filesystem.read.filter((p: string) => p !== "$HOME/.agents/skills").sort(),
    );
    expect(v2.security).toEqual(V1_PROFILE.security);
    expect(v2.workdir).toEqual(V1_PROFILE.workdir);
  });

  const maybeNono = Bun.which("nono") ? test : test.skip; // skipped visibly when nono is not installed
  maybeNono("is accepted by `nono profile validate` (positive control: a broken profile is rejected)", () => {
    const good = run(["nono", "profile", "validate", V2_PROFILE_PATH]);
    expect(good.code).toBe(0);
    const bad = join(scratch, "bad.json");
    writeFileSync(bad, '{"filesystem": {"allow": "not-a-list"}}');
    expect(run(["nono", "profile", "validate", bad]).code).not.toBe(0);
  });
});

describe("V2 launcher config", () => {
  const show = (home: string) =>
    run(["bash", "-c", `source "${ROOT}/scripts/secure-launcher-v2.conf"; printf '%s\\n' "$V2_PORT" "$V2_BIN" "$V2_NONO_PROFILE" "$V2_ROOT" "$CONTROL_DIR"`], { env: { HOME: home } });

  test("uses port 4097, a binary outside ~/.opencode, and roots under opencode-v2", () => {
    const home = join(scratch, "home-conf");
    mkdirSync(home);
    const [port, bin, profile, v2root, control] = show(home).out.trim().split("\n");
    expect(port).toBe("4097");
    expect(bin!.startsWith(join(home, ".opencode"))).toBe(false);
    expect(bin).toContain("opencode-v2");
    expect(profile).toBe("opencode-v2-secure");
    expect(v2root).toBe(join(home, ".local/share/opencode-v2"));
    expect(control).toBe(join(home, ".local/share/opencode-sandbox-control"));
  });
});

describe("start-secure-opencode-v2", () => {
  const LAUNCHER = join(ROOT, "scripts/start-secure-opencode-v2");

  /** A throwaway HOME with a fake V2 binary, a password file and a fake nono that records what it is given. */
  function setup(name: string, options: { passwordMode?: number; noPassword?: boolean; noBinary?: boolean } = {}) {
    const home = join(scratch, name);
    const v2root = join(home, ".local/share/opencode-v2");
    const binDir = join(v2root, "prefix/node_modules/.bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(home, ".local/share/opencode-sandbox-control"), { recursive: true });
    if (!options.noBinary) {
      writeFileSync(join(binDir, "opencode2"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(binDir, "opencode2"), 0o755);
    }
    if (!options.noPassword) {
      writeFileSync(join(v2root, "server-password"), `${SECRET}\n`);
      chmodSync(join(v2root, "server-password"), options.passwordMode ?? 0o600);
    }
    const log = join(home, "nono.log");
    const fakeNono = join(home, "nono");
    writeFileSync(
      fakeNono,
      `#!/bin/sh\ncase "$*" in *validate*|*--dry-run*) exit 0;; esac\n{ echo "ARGS: $*"; env | sort; } > "${log}"\nexit 0\n`,
    );
    chmodSync(fakeNono, 0o755);
    return { home, log, fakeNono, cwd: join(home, ".local/share/opencode-sandbox-control") };
  }

  const launch = (s: ReturnType<typeof setup>, extra: string[] = []) =>
    run(["bash", LAUNCHER, ...extra], { cwd: s.cwd, env: { HOME: s.home, NONO_BIN: s.fakeNono } });

  test("refuses to start from a git checkout (exit 3), before touching anything else", () => {
    const s = setup("refuse-git");
    const checkout = join(s.home, "some-checkout");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    const r = run(["bash", LAUNCHER], { cwd: checkout, env: { HOME: s.home, NONO_BIN: s.fakeNono } });
    expect(r.code).toBe(3);
    expect(existsSync(s.log)).toBe(false);
  });

  test("refuses to start from inside a configured project root (exit 3)", () => {
    const s = setup("refuse-root");
    const project = join(s.home, "projects/app");
    mkdirSync(project, { recursive: true });
    const r = run(["bash", LAUNCHER], { cwd: project, env: { HOME: s.home, NONO_BIN: s.fakeNono, V2_EXTRA_PROJECT_ROOTS: join(s.home, "projects") } });
    expect(r.code).toBe(3);
    expect(existsSync(s.log)).toBe(false);
  });

  test("--control-dir cannot be used to smuggle a project directory past the refusals (exit 3)", () => {
    const s = setup("control-dir-project");
    const project = join(s.home, "projects/app");
    mkdirSync(project, { recursive: true });
    const r = run(["bash", LAUNCHER, "--control-dir", project], { cwd: project, env: { HOME: s.home, NONO_BIN: s.fakeNono, V2_EXTRA_PROJECT_ROOTS: join(s.home, "projects") } });
    expect(r.code).toBe(3);
    expect(existsSync(s.log)).toBe(false);
  });

  test("--control-dir cannot name a git checkout either (exit 3)", () => {
    const s = setup("control-dir-git");
    const checkout = join(s.home, "checkout");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    const r = run(["bash", LAUNCHER, "--control-dir", checkout], { cwd: checkout, env: { HOME: s.home, NONO_BIN: s.fakeNono } });
    expect(r.code).toBe(3);
  });

  test("--control-dir with a safe directory is accepted (positive control)", () => {
    const s = setup("control-dir-ok");
    const control = join(s.home, "elsewhere-control");
    mkdirSync(control, { recursive: true });
    const r = run(["bash", LAUNCHER, "--control-dir", control], { cwd: control, env: { HOME: s.home, NONO_BIN: s.fakeNono } });
    expect(r.code).toBe(0);
  });

  test("refuses when the V2 binary is missing (exit 4)", () => {
    const s = setup("no-binary", { noBinary: true });
    expect(launch(s).code).toBe(4);
  });

  test("refuses when the V2 binary resolves into the V1 install", () => {
    const s = setup("v1-binary");
    const r = run(["bash", "-c", `OPENCODE_V2_BIN="$HOME/.opencode/bin/opencode" bash "${LAUNCHER}"`], { cwd: s.cwd, env: { HOME: s.home, NONO_BIN: s.fakeNono } });
    expect(r.code).toBe(4);
    expect(r.err).toContain("V1");
  });

  test("refuses without a server password file (exit 6)", () => {
    const s = setup("no-password", { noPassword: true });
    const r = launch(s);
    expect(r.code).toBe(6);
    expect(r.err).toContain("server-password");
  });

  test("refuses a password file that others can read (exit 6)", () => {
    const s = setup("loose-password", { passwordMode: 0o644 });
    expect(launch(s).code).toBe(6);
  });

  test("starts nono with the V2 profile, port, binary and isolated roots; the password reaches only the environment", () => {
    const s = setup("ok");
    const r = launch(s);
    expect(r.code).toBe(0);
    const log = readFileSync(s.log, "utf8");
    const args = log.split("\n")[0]!;
    expect(args).toContain("nono/profile/opencode-v2-secure.json");
    expect(args).toContain("serve --hostname 127.0.0.1 --port 4097");
    expect(args).toContain("prefix/node_modules/.bin/opencode2");
    expect(args).not.toContain(SECRET);
    expect(log).toContain(`OPENCODE_SERVER_PASSWORD=${SECRET}`);
    // The V2 roots reach only the server, as an `env` wrapper INSIDE the sandbox. nono itself must not see them: it keeps
    // its own state under $XDG_STATE_HOME/nono, which would then sit inside the profile's writable V2 state grant, and
    // nono refuses to start ("overlaps protected nono state root"). Found on the first real start, 2026-10-30.
    const v2 = join(s.home, ".local/share/opencode-v2");
    for (const [key, dir] of [["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_STATE_HOME", "state"], ["XDG_CACHE_HOME", "cache"]]) {
      expect(args).toContain(`${key}=${join(v2, dir!)}`);
      expect(log.split("\n").filter((line) => line.startsWith(`${key}=`))).toEqual([]); // not in nono's own environment
    }
    expect(args).toContain("OPENCODE_DISABLE_CLAUDE_CODE=1");
    expect(args).toMatch(/ env [A-Z_]+=/);
  });

  test("never prints the password", () => {
    const s = setup("quiet");
    const r = launch(s);
    expect(r.out + r.err).not.toContain(SECRET);
  });
});

describe("install-user-files-v2 and rollback-v2", () => {
  const INSTALL = join(ROOT, "scripts/install-user-files-v2");
  const ROLLBACK = join(ROOT, "scripts/rollback-v2");

  const env = (home: string) => ({ HOME: home, BROKER_STATE_DIR: join(home, "state") });
  const V2_PLUGINS = (home: string) => join(home, ".local/share/opencode-v2/config/opencode/plugins");

  test("dry-run (the default) installs nothing", () => {
    const home = join(scratch, "inst-dry");
    mkdirSync(home);
    const r = run(["bash", INSTALL], { env: env(home) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("00-routing-guard.ts");
    expect(existsSync(join(home, ".local"))).toBe(false);
  });

  test("--apply installs the V2 entries and libraries into the V2 config root only, and journals them", () => {
    const home = join(scratch, "inst-apply");
    mkdirSync(home);
    const r = run(["bash", INSTALL, "--apply"], { env: env(home) });
    expect(r.code).toBe(0);
    const plugins = V2_PLUGINS(home);
    for (const file of ["00-routing-guard.ts", "sandbox-tools.ts", "reviewer-relay-transport.ts", "lib/v2-adapter.ts", "lib/guard-core.ts", "lib/relay-v2.ts", "lib/tool-runtime.ts", "lib/broker-client.ts", "lib/reviewer-relay-core.ts"]) {
      expect(existsSync(join(plugins, file))).toBe(true);
    }
    expect(existsSync(join(home, ".config/opencode"))).toBe(false); // V1 tree untouched
    expect(existsSync(join(home, ".config/nono/profiles/opencode-v2-secure.json"))).toBe(true);
    expect(readFileSync(join(home, "state/install-journal-v2.tsv"), "utf8")).toContain("00-routing-guard.ts");
  });

  test("the fragments are staged for manual merge, never merged", () => {
    const home = join(scratch, "inst-fragments");
    mkdirSync(home);
    run(["bash", INSTALL, "--apply"], { env: env(home) });
    const staged = join(home, ".local/share/opencode-v2/fragments");
    expect(readdirSync(staged).sort()).toEqual(["reviewer-relay-agents.jsonc", "role-agents.jsonc", "sandbox-permissions.jsonc"]);
    expect(existsSync(join(home, ".local/share/opencode-v2/config/opencode/opencode.json"))).toBe(false);
  });

  test("--apply is idempotent and keeps a .bak when a destination differs", () => {
    const home = join(scratch, "inst-bak");
    mkdirSync(home);
    run(["bash", INSTALL, "--apply"], { env: env(home) });
    const guard = join(V2_PLUGINS(home), "00-routing-guard.ts");
    writeFileSync(guard, "// edited by hand\n");
    const again = run(["bash", INSTALL, "--apply"], { env: env(home) });
    expect(again.code).toBe(0);
    expect(readdirSync(V2_PLUGINS(home)).some((f) => f.startsWith("00-routing-guard.ts.bak"))).toBe(true);
    expect(readFileSync(guard, "utf8")).toContain("routing guard");
  });

  test("two applies in the same second keep both backups", () => {
    const home = join(scratch, "inst-bak2");
    mkdirSync(home);
    run(["bash", INSTALL, "--apply"], { env: env(home) });
    const guard = join(V2_PLUGINS(home), "00-routing-guard.ts");
    writeFileSync(guard, "// first edit\n");
    run(["bash", INSTALL, "--apply"], { env: env(home) });
    writeFileSync(guard, "// second edit\n");
    run(["bash", INSTALL, "--apply"], { env: env(home) });
    const backups = readdirSync(V2_PLUGINS(home)).filter((f) => f.startsWith("00-routing-guard.ts.bak"));
    expect(backups).toHaveLength(2);
    expect(new Set(backups.map((f) => readFileSync(join(V2_PLUGINS(home), f), "utf8"))).size).toBe(2);
  });

  test("a destination that cannot be written is refused before ANY file is installed (no partial install)", () => {
    const home = join(scratch, "inst-partial");
    mkdirSync(join(home, "elsewhere"), { recursive: true });
    mkdirSync(V2_PLUGINS(home), { recursive: true });
    symlinkSync(join(home, "elsewhere"), join(V2_PLUGINS(home), "lib")); // a late destination sits behind a symlink
    const r = run(["bash", INSTALL, "--apply"], { env: env(home) });
    expect(r.code).not.toBe(0);
    expect(existsSync(join(V2_PLUGINS(home), "00-routing-guard.ts"))).toBe(false);
    expect(readdirSync(join(home, "elsewhere"))).toEqual([]);
  });

  test("rollback removes only files that still match the repo copy", () => {
    const home = join(scratch, "rollback");
    mkdirSync(home);
    run(["bash", INSTALL, "--apply"], { env: env(home) });
    const plugins = V2_PLUGINS(home);
    writeFileSync(join(plugins, "sandbox-tools.ts"), "// user edit\n");
    const dry = run(["bash", ROLLBACK], { env: env(home) });
    expect(dry.code).toBe(0);
    expect(existsSync(join(plugins, "00-routing-guard.ts"))).toBe(true); // dry run removes nothing
    const applied = run(["bash", ROLLBACK, "--apply"], { env: env(home) });
    expect(applied.code).toBe(0);
    expect(existsSync(join(plugins, "00-routing-guard.ts"))).toBe(false);
    expect(readFileSync(join(plugins, "sandbox-tools.ts"), "utf8")).toBe("// user edit\n");
  });
});
