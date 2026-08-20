import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkStoreRootPermissions, isContainedIn } from "../../src/paths";

import { binaryOnPath, countRunningHarnessProcesses } from "../../src/commands/shared";

describe("checkStoreRootPermissions", () => {
  test("is always null on win32, regardless of the real filesystem mode", () => {
    expect(checkStoreRootPermissions("win32")).toBeNull();
  });
});

describe("countRunningHarnessProcesses", () => {
  test("is null on every platform except win32 — those have /proc instead", () => {
    expect(countRunningHarnessProcesses("claude", "linux")).toBeNull();
    expect(countRunningHarnessProcesses("claude", "darwin")).toBeNull();
  });

  test("counts matching lines from an injected tasklist run", () => {
    const run = () =>
      [
        "claude.exe                   1234 Console                    1     50,000 K",
        "claude.exe                   5678 Console                    1     48,000 K",
      ].join("\r\n");

    expect(countRunningHarnessProcesses("claude", "win32", run)).toBe(2);
  });

  test("returns 0 when tasklist reports nothing running", () => {
    const run = () => "INFO: No tasks are running which match the specified criteria.\r\n";
    expect(countRunningHarnessProcesses("claude", "win32", run)).toBe(0);
  });

  test("falls back to null when the run function throws (e.g. tasklist missing from PATH)", () => {
    const run = () => {
      throw new Error("ENOENT");
    };
    expect(countRunningHarnessProcesses("claude", "win32", run)).toBeNull();
  });
});

describe("binaryOnPath", () => {
  test("finds a posix binary by scanning PATH directories", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asp-path-")));
    fs.writeFileSync(path.join(dir, "claude"), "");
    try {
      expect(binaryOnPath("claude", "linux", { PATH: dir })).toBe(true);
      expect(binaryOnPath("codex", "linux", { PATH: dir })).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tries every PATHEXT suffix on win32", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asp-path-")));
    fs.writeFileSync(path.join(dir, "claude.exe"), "");
    try {
      expect(binaryOnPath("claude", "win32", { PATH: dir, PATHEXT: ".COM;.EXE;.BAT" })).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The win32 delimiter is ";", not the real host's `path.delimiter" (":" on
  // posix, which would shred a multi-directory Windows PATH into garbage
  // fragments). Only a genuinely multi-directory PATH exercises this.
  test("splits a win32 PATH on ';' even when the real host delimiter is ':'", () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asp-path-")));
    const withBinary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asp-path-")));
    fs.writeFileSync(path.join(withBinary, "claude.exe"), "");
    try {
      expect(binaryOnPath("claude", "win32", { PATH: `${empty};${withBinary}` })).toBe(true);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
      fs.rmSync(withBinary, { recursive: true, force: true });
    }
  });

  test("is false when PATH is empty", () => {
    expect(binaryOnPath("claude", "linux", { PATH: "" })).toBe(false);
  });
});

// Shared by paths.ts (assertInsideStore) and shell/rc-path.ts (validateRcPath)
// — one implementation, imported by both. Exercised directly here (not
// through their fs.realpathSync-backed callers) so the comparison logic is
// portable: a real filesystem's own case sensitivity would otherwise decide
// the outcome before "platform" ever gets a say. Phase 3 is the real-NTFS
// verification gate for the full call chain.
describe("isContainedIn case sensitivity", () => {
  test("case-sensitive on posix", () => {
    // A win32-style path is deliberately wrong here: without it, a
    // backslash-only child would fail to match on the "/" separator alone,
    // passing the assertion for the wrong reason (separator, not case).
    expect(isContainedIn("/home/vinh", "/home/Vinh/work", "linux")).toBe(false);
  });

  test("case-insensitive on win32", () => {
    expect(isContainedIn("C:\\Users\\vinh", "C:\\Users\\Vinh\\work", "win32")).toBe(true);
  });

  test("win32 equality is also case-insensitive", () => {
    expect(isContainedIn("C:\\Users\\vinh", "C:\\Users\\VINH", "win32")).toBe(true);
  });

  test("win32 still refuses a path that is not actually contained", () => {
    expect(isContainedIn("C:\\Users\\vinh", "C:\\Users\\vinhother\\work", "win32")).toBe(false);
  });
});
