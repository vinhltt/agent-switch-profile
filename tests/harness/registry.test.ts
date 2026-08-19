import { describe, expect, test } from "bun:test";

import { claudeAdapter } from "../../src/harness/claude";
import { findHarness, getHarness, listHarnessNames } from "../../src/harness/registry";
import { ValidationError } from "../../src/validate";

describe("harness registry", () => {
  test("phase 0 ships claude only", () => {
    expect(listHarnessNames()).toEqual(["claude"]);
  });

  test("claude adapter relocates the documented config directory", () => {
    expect(claudeAdapter).toMatchObject({
      name: "claude",
      binary: "claude",
      configEnvVar: "CLAUDE_CONFIG_DIR",
      aliasPrefix: "cc",
      credentialsFile: ".credentials.json",
    });
  });

  test("getHarness resolves a known name", () => {
    expect(getHarness("claude")).toBe(claudeAdapter);
  });

  test("getHarness lists what is supported when the name is unknown", () => {
    expect(() => getHarness("codex")).toThrow(ValidationError);
    expect(() => getHarness("codex")).toThrow(/supported: claude/);
  });

  test("getHarness refuses empty and non-string names", () => {
    expect(() => getHarness("")).toThrow(ValidationError);
    expect(() => getHarness(undefined)).toThrow(ValidationError);
  });

  test("findHarness returns undefined rather than throwing", () => {
    expect(findHarness("nope")).toBeUndefined();
  });
});
