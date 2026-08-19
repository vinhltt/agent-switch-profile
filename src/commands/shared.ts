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

  return { source: "shell", rcPath: validateRcPath(detectRcFile(shell, homeDir), homeDir) };
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
