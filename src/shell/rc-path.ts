import * as fs from "node:fs";
import * as path from "node:path";

import { ValidationError } from "../validate";

/**
 * Files asp is willing to write a managed block into. `--rc` is an arbitrary
 * path from the command line and `rcFile` is read back out of a file the harness
 * can rewrite, so both go through here before anything is opened for writing.
 */
export const RC_BASENAME_ALLOWLIST = [
  ".bashrc",
  ".zshrc",
  ".bash_profile",
  ".zprofile",
  ".profile",
] as const;

function isContainedIn(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * Validate an rc file path and return it with its directory resolved.
 * The file itself may be absent — `create` is allowed to append to a rc file
 * the user has not made yet — but its directory must exist inside the home
 * directory, and anything already there must be a regular file.
 */
export function validateRcPath(rcPath: unknown, homeDir: string): string {
  if (typeof rcPath !== "string" || rcPath.length === 0) {
    throw new ValidationError("rc file path is required");
  }

  const resolved = path.resolve(rcPath);
  const basename = path.basename(resolved);
  if (!RC_BASENAME_ALLOWLIST.includes(basename as (typeof RC_BASENAME_ALLOWLIST)[number])) {
    throw new ValidationError(
      `refusing to write to ${resolved}: expected one of ${RC_BASENAME_ALLOWLIST.join(", ")}`,
    );
  }

  const realHome = fs.realpathSync(homeDir);

  let realParent: string;
  try {
    realParent = fs.realpathSync(path.dirname(resolved));
  } catch {
    throw new ValidationError(`rc file directory does not exist: ${path.dirname(resolved)}`);
  }
  if (!isContainedIn(realHome, realParent)) {
    throw new ValidationError(`rc file must live under ${realHome}, got ${resolved}`);
  }

  const normalized = path.join(realParent, basename);

  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(normalized);
  } catch {
    return normalized; // Absent is fine; the caller creates it.
  }

  if (stats.isSymbolicLink()) {
    // Dotfile managers symlink rc files; follow it, but only inside home.
    let target: string;
    try {
      target = fs.realpathSync(normalized);
    } catch {
      throw new ValidationError(`rc file is a broken symlink: ${normalized}`);
    }
    if (!isContainedIn(realHome, target)) {
      throw new ValidationError(
        `rc file ${normalized} is a symlink pointing outside ${realHome}: ${target}`,
      );
    }
    if (!fs.statSync(target).isFile()) {
      throw new ValidationError(`rc file symlink does not point at a regular file: ${target}`);
    }
    return normalized;
  }

  if (!stats.isFile()) {
    throw new ValidationError(`rc path is not a regular file: ${normalized}`);
  }

  return normalized;
}

/**
 * Map the user's login shell to its rc file. Phase 0 refuses anything else
 * rather than writing POSIX syntax into a file the shell cannot parse.
 */
export function detectRcFile(shell: string | undefined, homeDir: string): string {
  if (typeof shell !== "string" || shell.trim().length === 0) {
    throw new ValidationError(
      "$SHELL is not set, so asp cannot tell which rc file to use — pass --rc <path>",
    );
  }

  switch (path.basename(shell.trim())) {
    case "bash":
      return path.join(homeDir, ".bashrc");
    case "zsh":
      return path.join(homeDir, ".zshrc");
    default:
      throw new ValidationError(
        `unsupported shell ${JSON.stringify(shell)}: asp supports bash and zsh — ` +
          `pass --rc <path> to choose the file yourself`,
      );
  }
}
