import { describe, expect, test } from "bun:test";

import { buildProgram } from "../src/program";

describe("buildProgram", () => {
  test("names the program asp", () => {
    expect(buildProgram().name()).toBe("asp");
  });

  test("registers the three phase-0 subcommands", () => {
    const names = buildProgram()
      .commands.map((command) => command.name())
      .sort();
    expect(names).toEqual(["create", "delete", "list"]);
  });

  test("declares --harness on the root program so subcommands inherit it", () => {
    const harness = buildProgram().options.find((option) => option.long === "--harness");
    expect(harness).toBeDefined();
    expect(harness?.required).toBe(true);
  });

  test("reports the package version", () => {
    expect(buildProgram().version()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
