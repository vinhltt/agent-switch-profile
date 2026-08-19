import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  findProcessesUsingProfile,
  isInteractive,
  resolveHarness,
  resolveRcPath,
} from "../../src/commands/shared";
import { claudeAdapter } from "../../src/harness/claude";
import { DEFAULT_STORE_CONFIG, writeStoreConfig } from "../../src/store-config";
import { ValidationError } from "../../src/validate";

import { createTempHome, type TempHome } from "../helpers/temp-home";

let tmp: TempHome;

beforeEach(() => {
  tmp = createTempHome();
});
afterEach(() => {
  tmp.cleanup();
});

describe("isInteractive", () => {
  const streams = [process.stdin, process.stdout] as const;
  let saved: (boolean | undefined)[];

  beforeEach(() => {
    saved = streams.map((stream) => stream.isTTY);
  });
  afterEach(() => {
    streams.forEach((stream, index) => {
      Object.defineProperty(stream, "isTTY", { value: saved[index], configurable: true });
    });
  });

  function setTty(stdin: boolean, stdout: boolean): void {
    Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
  }

  test("true only when both streams are a terminal", () => {
    setTty(true, true);
    expect(isInteractive()).toBe(true);
  });

  // The shipped hang: stdout was a terminal, so the prompt drew itself, but
  // stdin was closed, so the answer never came.
  test("false when stdout is a terminal but stdin is not", () => {
    setTty(false, true);
    expect(isInteractive()).toBe(false);
  });

  test("false when stdin is a terminal but stdout is not", () => {
    setTty(true, false);
    expect(isInteractive()).toBe(false);
  });

  test("false when neither is", () => {
    setTty(false, false);
    expect(isInteractive()).toBe(false);
  });
});

describe("findProcessesUsingProfile", () => {
  const dir = "/home/u/.agent-switch-profiles/claude/work";

  function withEnv(value: string, run: () => void): void {
    const child = spawn("sleep", ["20"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: value },
      stdio: "ignore",
    });
    try {
      // Give the kernel a moment to publish /proc/<pid>/environ.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !fs.existsSync(`/proc/${child.pid}/environ`)) {
        /* spin */
      }
      run();
    } finally {
      child.kill();
    }
  }

  test.skipIf(process.platform !== "linux")("finds a process holding the directory", () => {
    withEnv(dir, () => {
      expect(findProcessesUsingProfile("CLAUDE_CONFIG_DIR", dir).length).toBeGreaterThan(0);
    });
  });

  // A byte comparison called a live session absent when the environment spelled
  // the same directory differently — the wrong answer for a delete guard.
  test.skipIf(process.platform !== "linux").each([`${dir}/`, `${dir}/.`, `${dir}//`])(
    "still finds it when the environment spells it %p",
    (spelling: string) => {
      withEnv(spelling, () => {
        expect(findProcessesUsingProfile("CLAUDE_CONFIG_DIR", dir).length).toBeGreaterThan(0);
      });
    },
  );

  test.skipIf(process.platform !== "linux")("does not match a different profile", () => {
    withEnv(`${dir}-other`, () => {
      expect(findProcessesUsingProfile("CLAUDE_CONFIG_DIR", dir)).toEqual([]);
    });
  });
});

describe("resolveHarness", () => {
  test("takes the flag when given", () => {
    expect(resolveHarness({ harness: "claude" })).toBe(claudeAdapter);
  });

  test("falls back to the store default", () => {
    expect(resolveHarness({})).toBe(claudeAdapter);
  });

  test("rejects an unknown flag value", () => {
    expect(() => resolveHarness({ harness: "codex" })).toThrow(ValidationError);
  });

  test("rejects an unknown default recorded in the store", () => {
    writeStoreConfig({ ...DEFAULT_STORE_CONFIG, defaultHarness: "gemini" });
    expect(() => resolveHarness({})).toThrow(/unknown harness/);
  });
});

describe("resolveRcPath precedence", () => {
  test("--rc beats everything", () => {
    const explicit = path.join(tmp.home, ".zshrc");
    fs.writeFileSync(explicit, "");
    writeStoreConfig({ ...DEFAULT_STORE_CONFIG, defaultRcFile: tmp.rcFile });

    expect(resolveRcPath(explicit, tmp.rcFile, tmp.home, "/bin/bash")).toEqual({
      source: "flag",
      rcPath: explicit,
    });
  });

  test("the profile's recorded file beats the store default and the shell", () => {
    const recorded = path.join(tmp.home, ".zshrc");
    fs.writeFileSync(recorded, "");
    expect(resolveRcPath(undefined, recorded, tmp.home, "/bin/bash")).toEqual({
      source: "profile",
      rcPath: recorded,
    });
  });

  test("the store default beats the shell", () => {
    const configured = path.join(tmp.home, ".zprofile");
    fs.writeFileSync(configured, "");
    writeStoreConfig({ ...DEFAULT_STORE_CONFIG, defaultRcFile: configured });

    expect(resolveRcPath(undefined, undefined, tmp.home, "/bin/bash")).toEqual({
      source: "config",
      rcPath: configured,
    });
  });

  test("falls back to the login shell", () => {
    expect(resolveRcPath(undefined, undefined, tmp.home, "/bin/zsh")).toEqual({
      source: "shell",
      rcPath: path.join(tmp.home, ".zshrc"),
    });
  });

  // A path read out of profile.json is as untrusted as one typed on the command
  // line, so it goes through the same allowlist.
  test("validates a recorded path just as strictly as a flag", () => {
    expect(() => resolveRcPath(undefined, "/etc/passwd", tmp.home, "/bin/bash")).toThrow(
      ValidationError,
    );
    expect(() =>
      resolveRcPath(undefined, path.join(tmp.home, ".ssh", "authorized_keys"), tmp.home, "/bin/bash"),
    ).toThrow(ValidationError);
  });

  test("refuses an unsupported shell with a usable hint", () => {
    expect(() => resolveRcPath(undefined, undefined, tmp.home, "/usr/bin/fish")).toThrow(/--rc/);
  });

  test("refuses when $SHELL is unset", () => {
    expect(() => resolveRcPath(undefined, undefined, tmp.home, undefined)).toThrow(/\$SHELL/);
  });
});
