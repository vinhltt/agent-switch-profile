import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { hostPathsFor, upsertAlias } from "../../src/shell/rc-block";

/**
 * The unit tests prove what asp writes. These prove a real shell agrees: it
 * sources the rc file, expands the alias, and hands the binary the config
 * directory asp intended — including from home directories full of characters
 * that would otherwise end the quoting early or run a command.
 */

let base: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asp-shell-")));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function shellExists(shell: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${shell}`], { encoding: "utf8" }).status === 0;
}

function runThroughShell(shell: string, homeName: string): { output: string; expected: string } {
  const home = path.join(base, homeName);
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });

  // Stands in for `claude`, reporting only which config dir it received.
  const stub = path.join(bin, "claude");
  fs.writeFileSync(stub, '#!/usr/bin/env bash\necho "CONFIG_DIR=[$CLAUDE_CONFIG_DIR]"\n');
  fs.chmodSync(stub, 0o755);

  const profileDir = path.join(home, ".agent-switch-profiles", "claude", "work");
  fs.mkdirSync(profileDir, { recursive: true });

  const rcName = shell === "zsh" ? ".zshrc" : ".bashrc";
  const rcPath = path.join(home, rcName);
  fs.writeFileSync(rcPath, "# prologue\n");

  upsertAlias(rcPath, hostPathsFor(home, "linux"), {
    alias: "ccwork",
    profileDir,
    envVar: "CLAUDE_CONFIG_DIR",
    binary: "claude",
  });

  // Separate lines: aliases are expanded when a command is parsed, so `ccwork`
  // must be parsed after `source` has already run.
  const script =
    shell === "zsh"
      ? `source "$HOME/${rcName}"\nccwork\n`
      : `shopt -s expand_aliases\nsource "$HOME/${rcName}"\nccwork\n`;

  const result = spawnSync(shell, ["-s"], {
    input: script,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });

  return { output: (result.stdout ?? "").trim(), expected: `CONFIG_DIR=[${profileDir}]` };
}

const hostileHomes = ["plain", "o'brien dir", "dollar$and`tick", 'has"quote', "semi;colon"];

describe("bash", () => {
  test.each(hostileHomes)("expands the alias correctly from a home named %p", (homeName) => {
    const { output, expected } = runThroughShell("bash", homeName);
    expect(output).toBe(expected);
  });
});

describe.skipIf(!shellExists("zsh"))("zsh", () => {
  test.each(hostileHomes)("expands the alias correctly from a home named %p", (homeName) => {
    const { output, expected } = runThroughShell("zsh", homeName);
    expect(output).toBe(expected);
  });
});
