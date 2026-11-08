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

test("BROKER_MAX_WORKERS sets the pool cap; the default is 4", () => {
  const saved = process.env.BROKER_MAX_WORKERS;
  try {
    delete process.env.BROKER_MAX_WORKERS;
    expect(defaultConfig().resource.maxWorkers).toBe(4);

    process.env.BROKER_MAX_WORKERS = "6";
    expect(defaultConfig().resource.maxWorkers).toBe(6);

    // Positive control: the aggregate and per-worker caps keep their defaults,
    // so raising maxWorkers alone cannot oversubscribe the host.
    const resource = defaultConfig().resource;
    expect(resource.maxAggregateCpu).toBe(8);
    expect(resource.maxAggregateMemBytes).toBe(8 * 1024 ** 3);
    expect(resource.perWorkerCpu).toBe(2);
    expect(resource.perWorkerMemBytes).toBe(2 * 1024 ** 3);
  } finally {
    if (saved === undefined) delete process.env.BROKER_MAX_WORKERS;
    else process.env.BROKER_MAX_WORKERS = saved;
  }
});

test("BROKER_MAX_WORKERS refuses a present but invalid value", () => {
  const saved = process.env.BROKER_MAX_WORKERS;
  try {
    for (const bad of ["0", "-1", "1.5", "many"]) {
      process.env.BROKER_MAX_WORKERS = bad;
      expect(() => defaultConfig()).toThrow(/invalid BROKER_MAX_WORKERS/);
    }
  } finally {
    if (saved === undefined) delete process.env.BROKER_MAX_WORKERS;
    else process.env.BROKER_MAX_WORKERS = saved;
  }
});
