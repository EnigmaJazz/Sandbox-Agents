import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { assertWorkerEnv } from "../src/msb.ts";

const allowedKeys = defaultConfig().resource.envAllowedKeys;

describe("worker environment allowlist", () => {
  test("allows the temporary Git index used by worker diff construction", () => {
    expect(
      assertWorkerEnv(
        { GIT_INDEX_FILE: "/work/.broker-tmp/x.index" },
        allowedKeys,
      ),
    ).toEqual({ GIT_INDEX_FILE: "/work/.broker-tmp/x.index" });
  });

  test("does not treat GIT_* as a wildcard", () => {
    expect(() =>
      assertWorkerEnv({ GIT_SSH_COMMAND: "ssh" }, allowedKeys),
    ).toThrow("env key 'GIT_SSH_COMMAND' is not on the worker env allowlist");
  });

  test("always rejects credential-shaped keys", () => {
    expect(() =>
      assertWorkerEnv({ GIT_ACCESS_TOKEN: "secret" }, allowedKeys),
    ).toThrow(
      "env key 'GIT_ACCESS_TOKEN' looks like a credential and is always rejected (S8/S9)",
    );
  });
});
