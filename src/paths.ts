import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ValidationError } from "./validate";

export const STORE_DIR_NAME = ".agent-switch-profiles";
/** Store directories hold OAuth credentials, so nothing is readable by group or other. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Explicit-home variants exist so the rc-file modules can stay pure. */
export function storeRootFor(homeDir: string): string {
  return path.join(homeDir, STORE_DIR_NAME);
}

export function backupsDirFor(homeDir: string): string {
  return path.join(storeRootFor(homeDir), "backups");
}

export function storeRoot(): string {
  return storeRootFor(os.homedir());
}

export function backupsDir(): string {
  return backupsDirFor(os.homedir());
}

export function harnessDir(harness: string): string {
  return path.join(storeRoot(), harness);
}

export function profileDir(harness: string, name: string): string {
  return path.join(harnessDir(harness), name);
}

/**
 * Resolve symlinks as far as the path exists, then re-attach the segments that
 * do not exist yet. Plain `realpathSync` throws ENOENT on a directory we are
 * about to create, which is exactly when containment has to be checked.
 */
export function realpathAllowingMissing(target: string): string {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Walked past the filesystem root without finding anything real.
        return absolute;
      }
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * NTFS is case-insensitive, so win32 must not refuse `C:\Users\Vinh` under
 * `C:\Users\vinh`. The separator is picked from `platform`, not the real
 * `path.sep`, so this is testable on Linux for the win32 branch too.
 */
export function isContainedIn(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const sep = platform === "win32" ? path.win32.sep : path.posix.sep;
  if (platform === "win32") {
    const parentLower = parent.toLowerCase();
    const childLower = child.toLowerCase();
    return childLower === parentLower || childLower.startsWith(parentLower + sep);
  }
  return child === parent || child.startsWith(parent + sep);
}

/**
 * Refuse a symlink at the store root or anywhere below it, on the literal path.
 *
 * This must run before the path is resolved. Resolving first launders a link:
 * `claude/work -> claude/real` becomes `claude/real`, which contains no symlink
 * and sits comfortably inside the store, so every later check passes and the
 * caller deletes the wrong profile.
 */
function assertNoSymlinkComponents(root: string, segments: readonly string[]): void {
  let current = root;

  for (let index = 0; index <= segments.length; index += 1) {
    if (index > 0) {
      current = path.join(current, segments[index - 1] as string);
    }
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      // Does not exist yet: nothing to impersonate.
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new ValidationError(
        `refusing to operate through a symlink inside the profile store: ${current}`,
      );
    }
  }
}

export interface ContainmentOptions {
  /** Require an existing real directory — used before anything is deleted. */
  mustBeExistingDir?: boolean;
}

/**
 * Prove that `target` really lives inside the store and reaches it without
 * traversing a symlink, then return the path callers may act on.
 */
export function assertInsideStore(
  target: string,
  options: ContainmentOptions = {},
  platform: NodeJS.Platform = process.platform,
): string {
  const root = storeRoot();
  const absolute = path.resolve(target);

  // Lexical containment first: it collapses any `..` and gives the symlink walk
  // below a path to walk.
  const relative = path.relative(root, absolute);
  if (relative === "") {
    throw new ValidationError("refusing to operate on the profile store root itself");
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ValidationError(`path escapes the profile store: ${target}`);
  }

  assertNoSymlinkComponents(root, relative.split(path.sep));

  // Containment must also survive symlinks resolved above the store root, e.g.
  // a home directory reached through one.
  if (!isContainedIn(realpathAllowingMissing(root), realpathAllowingMissing(absolute), platform)) {
    throw new ValidationError(`path escapes the profile store: ${target}`);
  }

  if (options.mustBeExistingDir) {
    const stats = fs.lstatSync(absolute);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new ValidationError(`not a real directory: ${absolute}`);
    }
  }

  return absolute;
}

export interface StoreRootPermissions {
  mode: number;
  /** True when the directory is readable or writable beyond its owner. */
  loose: boolean;
}

/**
 * Returns null when the store root does not exist yet, or on win32: Node
 * fabricates a `stats.mode` on Windows (it does not track POSIX permission
 * bits), so `mode & 0o077` is nonzero for effectively every file and the
 * warning would fire on every `list`. Real protection there comes from the
 * user profile's inherited ACL, not this check.
 */
export function checkStoreRootPermissions(
  platform: NodeJS.Platform,
): StoreRootPermissions | null {
  if (platform === "win32") return null;

  let stats: fs.Stats;
  try {
    stats = fs.statSync(storeRoot());
  } catch {
    return null;
  }
  const mode = stats.mode & 0o777;
  return { mode, loose: (mode & 0o077) !== 0 };
}
