import * as fs from "node:fs";
import * as path from "node:path";

import { isContainedIn } from "../paths";
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

/**
 * Validate an rc file path and return it with its directory resolved.
 * The file itself may be absent — `create` is allowed to append to a rc file
 * the user has not made yet — but its directory must exist inside the home
 * directory, and anything already there must be a regular file.
 */
export function validateRcPath(
  rcPath: unknown,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
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
  if (!isContainedIn(realHome, realParent, platform)) {
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
    if (!isContainedIn(realHome, target, platform)) {
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
 * A win32 process without `MSYSTEM` (set by Git Bash/MSYS2, e.g. `MINGW64`)
 * is PowerShell or CMD — neither can source a bash-syntax rc file. Positive
 * signal rather than an absent `$SHELL`, so it still fires even when `--rc`,
 * a recorded profile, or a configured default rc file would otherwise let a
 * command skip shell detection entirely.
 */
export function assertGitBashOnWindows(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): void {
  if (platform === "win32" && !env.MSYSTEM) {
    throw new ValidationError(
      "asp on Windows runs in Git Bash. PowerShell and CMD are not supported — open Git Bash, or use WSL.",
    );
  }
}

/**
 * Map the user's login shell to its rc file. Phase 0 refuses anything else
 * rather than writing POSIX syntax into a file the shell cannot parse.
 */
export function detectRcFile(
  shell: string | undefined,
  homeDir: string,
  platform: NodeJS.Platform,
): string {
  if (typeof shell !== "string" || shell.trim().length === 0) {
    // An unset $SHELL on win32 means PowerShell or CMD — point at the shell
    // asp actually supports there instead of asking for a flag that will not
    // help either. (assertGitBashOnWindows is the primary, earlier-firing
    // guard for this; this is a backstop for the same win32-without-Git-Bash
    // case reached through shell detection specifically.)
    if (platform === "win32") {
      throw new ValidationError(
        "asp on Windows runs in Git Bash. PowerShell and CMD are not supported — open Git Bash, or use WSL.",
      );
    }
    throw new ValidationError(
      "$SHELL is not set, so asp cannot tell which rc file to use — pass --rc <path>",
    );
  }

  // path.win32.basename parses both "/" and "\" as separators, so this reads
  // $SHELL correctly whether the host is posix or the value was rewritten to
  // a Windows path by MSYS/Git Bash — unlike the platform-native `path`,
  // which only understands the running OS's own separator. Stripping just a
  // trailing ".exe" (rather than using path.win32.parse().name, which strips
  // *any* extension) keeps a posix value like "/usr/bin/bash.real" rejected
  // exactly as it was before — only the Windows `.exe` suffix is special.
  switch (path.win32.basename(shell.trim()).replace(/\.exe$/i, "")) {
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
