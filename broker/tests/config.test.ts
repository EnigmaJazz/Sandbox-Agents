import { expect, test } from "bun:test";
import { ConfigError, defaultConfig } from "../src/config.ts";

test("defaults the review helper interpreter to null and accepts absolute paths", () => {
  expect(defaultConfig().reviewHelperInterpreter).toBeNull();
  expect(defaultConfig({ reviewHelperInterpreter: "/usr/bin/node" }).reviewHelperInterpreter).toBe("/usr/bin/node");
});

test("rejects empty, relative, and bare-name review helper interpreters", () => {
  for (const reviewHelperInterpreter of ["", "node", "./node"] as const) {
    expect(() => defaultConfig({ reviewHelperInterpreter })).toThrow(ConfigError);
    expect(() => defaultConfig({ reviewHelperInterpreter })).toThrow("invalid reviewHelperInterpreter");
  }
});
