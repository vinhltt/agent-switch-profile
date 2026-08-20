import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { getHarness, listHarnessNames } from "../harness/registry";
import type { HarnessAdapter } from "../harness/types";
import { detectRcFile, validateRcPath } from "../shell/rc-path";
import { readStoreConfig } from "../store-config";
import { ValidationError } from "../validate";

export const EXIT_OK = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_USAGE = 2;

/** Carries the exit code for failures that are neither usage errors nor crashes. */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT_RUNTIME) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export interface GlobalOptions {
  harness?: string;
}

/** `--harness` wins; otherwise the store's `defaultHarness`. */
export function resolveHarness(options: GlobalOptions): HarnessAdapter {
  if (options.harness) return getHarness(options.harness);

  const configured = readStoreConfig().defaultHarness;
  if (!configured) {
    throw new ValidationError(
      `no harness selected: pass --harness <name> (supported: ${listHarnessNames().join(", ")})`,
    );
  }
  return getHarness(configured);
}

export interface RcResolution {
  /** Where the value came from, so error messages can point at what to change. */
  source: "flag" | "profile" | "config" | "shell";
  rcPath: string;
}

/**
 * One precedence order for every command: `--rc`, then the path recorded in the
 * profile, then the store default, then the login shell's rc file. Every
 * candidate is validated, including the one read back out of `profile.json`.
 */
export function resolveRcPath(
  explicit: string | undefined,
  recorded: string | undefined,
  homeDir: string,
  /** Explicit rather than defaulted, so "unset" is expressible and testable. */
  shell: string | undefined,
): RcResolution {
  if (explicit) return { source: "flag", rcPath: validateRcPath(explicit, homeDir) };
  if (recorded) return { source: "profile", rcPath: validateRcPath(recorded, homeDir) };

  const configured = readStoreConfig().defaultRcFile;
  if (configured) return { source: "config", rcPath: validateRcPath(configured, homeDir) };

  return {
    source: "shell",
    rcPath: validateRcPath(detectRcFile(shell, homeDir, process.platform), homeDir),
  };
}

/**
 * Compare directories by meaning, not by spelling. `…/work`, `…/work/` and
 * `…/work/.` are the same directory, and a byte comparison would call a live
 * session absent — the wrong answer for a check that exists to stop a delete.
 */
function sameDirectory(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value);
    return normalized.length > 1 && normalized.endsWith(path.sep)
      ? normalized.slice(0, -1)
      : normalized;
  };
  return normalize(a) === normalize(b);
}

/**
 * Processes still running against this profile directory. Unreadable entries are
 * skipped: another user's process is not something we can inspect, and failing
 * to look is not evidence of absence.
 */
export function findProcessesUsingProfile(configEnvVar: string, profileDir: string): number[] {
  if (process.platform !== "linux") return [];

  let pids: string[];
  try {
    pids = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }

  const prefix = `${configEnvVar}=`;
  const found: number[] = [];

  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    try {
      const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      const entry = environ.find((line) => line.startsWith(prefix));
      if (entry && sameDirectory(entry.slice(prefix.length), profileDir)) {
        found.push(Number(pid));
      }
    } catch {
      // EACCES for another user's process, ENOENT for one that just exited.
    }
  }
  return found;
}

/**
 * `spawnSync` does not throw on its own — a missing `tasklist` (e.g. not on
 * Git Bash's PATH) surfaces as `result.error`/a null status, not an
 * exception — so this throws explicitly, letting the try/catch in
 * `countRunningHarnessProcesses` fall back to null instead of misreading a
 * failed run as "0 processes found".
 */
function defaultRun(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${cmd} exited with status ${result.status}`);
  }
  return result.stdout ?? "";
}

/**
 * Processes matching `binary` currently running, or null when this platform
 * has no way to check. `/proc` covers linux via `findProcessesUsingProfile`;
 * this covers win32 with a coarser count, since Windows exposes no
 * unprivileged way to read another process's environment (reading it needs
 * `ReadProcessMemory` into the PEB, which needs a native addon or debug
 * rights) — so asp can warn that *something* is running, not which profile.
 */
export function countRunningHarnessProcesses(
  binary: string,
  platform: NodeJS.Platform,
  run: (cmd: string, args: string[]) => string = defaultRun,
): number | null {
  if (platform !== "win32") return null;

  let output: string;
  try {
    output = run("tasklist", ["/FI", `IMAGENAME eq ${binary}.exe`, "/NH"]);
  } catch {
    return null;
  }

  const imageName = `${binary.toLowerCase()}.exe`;
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && line.toLowerCase().startsWith(imageName)).length;
}

/**
 * Whether `binary` is reachable on PATH. Pure and platform-injected: no
 * subprocess, so it is cheap enough to call before every `create`/`list`.
 *
 * win32 matches case-insensitively — NTFS is, and `PATHEXT` is conventionally
 * uppercase (`.EXE`) while installed binaries are usually lowercase
 * (`claude.exe`) — by reading each directory's entries once instead of
 * probing `fs.existsSync` per candidate, so this is exercised the same way
 * on any host filesystem, case-sensitive or not.
 */
export function binaryOnPath(
  binary: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): boolean {
  // From `platform`, not the real `path.delimiter` — otherwise the win32
  // branch below is untestable from a posix host, where the real delimiter
  // (":") would shred a Windows-style "C:\Windows;C:\nodejs" PATH value.
  const delimiter = platform === "win32" ? ";" : ":";
  const dirs = (env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);

  if (platform !== "win32") {
    return dirs.some((dir) => fs.existsSync(path.join(dir, binary)));
  }

  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  const candidates = new Set(extensions.map((ext) => `${binary}${ext}`.toLowerCase()));

  return dirs.some((dir) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return false;
    }
    return names.some((name) => candidates.has(name.toLowerCase()));
  });
}

/** True only when both streams are a terminal: prompts read stdin but draw on stdout. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

const SHOW_CURSOR = "\u001B[?25h";

/** Restore the cursor if a prompt is interrupted mid-draw. */
export function installCursorGuard(): void {
  const restore = (): void => {
    if (process.stdout.isTTY) process.stdout.write(SHOW_CURSOR);
  };
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });
}
