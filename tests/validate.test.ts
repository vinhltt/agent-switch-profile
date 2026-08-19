import { describe, expect, test } from "bun:test";

import { ValidationError, validateAliasName, validateProfileName } from "../src/validate";

describe("validateProfileName", () => {
  test.each(["work", "personal", "client-a", "a", "team-2", "0day"])("accepts %p", (name) => {
    expect(validateProfileName(name)).toBe(name);
  });

  test.each([
    ["..", "traversal"],
    [".", "traversal"],
    ["a/b", "path separator"],
    ["a\\b", "windows separator"],
    ["../../etc", "traversal prefix"],
    ["Work", "uppercase"],
    ["-lead", "leading dash"],
    ["with space", "space"],
    ["with_underscore", "underscore is alias-only"],
    ["", "empty"],
    ["x".repeat(33), "too long"],
  ])("rejects %p (%s)", (name) => {
    expect(() => validateProfileName(name)).toThrow(ValidationError);
  });

  test("rejects non-string input", () => {
    expect(() => validateProfileName(undefined)).toThrow(ValidationError);
    expect(() => validateProfileName(42)).toThrow(ValidationError);
  });
});

describe("validateAliasName", () => {
  test.each(["ccwork", "cc_work", "cc-work", "_private", "cc2"])("accepts %p", (alias) => {
    expect(validateAliasName(alias)).toBe(alias);
  });

  // Every one of these would change the meaning of the generated rc line.
  test.each([
    ["cc'work", "single quote"],
    ['cc"work', "double quote"],
    ["cc work", "space"],
    ["cc;rm -rf /", "command separator"],
    ["cc$(id)", "command substitution"],
    ["cc`id`", "backtick substitution"],
    ["cc$HOME", "variable expansion"],
    ["cc\nalias evil=x", "newline injecting a second line"],
    ["cc=work", "assignment"],
    ["cc|work", "pipe"],
    ["cc&work", "background"],
    ["cc>out", "redirect"],
    ["cc#work", "comment"],
    ["cc\\work", "backslash"],
    ["CCWork", "uppercase"],
    ["2cc", "leading digit"],
    ["-cc", "leading dash"],
    ["", "empty"],
    ["c".repeat(33), "too long"],
  ])("rejects %p (%s)", (alias) => {
    expect(() => validateAliasName(alias)).toThrow(ValidationError);
  });

  test("error message names the refused characters", () => {
    expect(() => validateAliasName("cc;x")).toThrow(/shell rc file/);
  });
});
