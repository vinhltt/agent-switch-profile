import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { HarnessAdapter } from "./harness/types";
import { findHarness } from "./harness/registry";
import { DIR_MODE, FILE_MODE, assertInsideStore, harnessDir, profileDir } from "./paths";
import { validateRcPath } from "./shell/rc-path";
import { ValidationError, validateAliasName, validateProfileName } from "./validate";

/**
 * asp writes exactly one file into the harness config directory. The harness
 * owns everything else in there and ignores files it does not know.
 */
export const PROFILE_META_FILENAME = "profile.json";

export interface ProfileMeta {
  harness: string;
  name: string;
  alias: string;
  rcFile: string;
  createdAt: string;
}

export type ProfileMetaResult =
  | { status: "ok"; meta: ProfileMeta }
  /** No metadata file: the directory exists but asp did not finish creating it. */
  | { status: "missing" }
  /** Present but untrustworthy. Callers must fall back to derived values. */
  | { status: "invalid"; reason: string };

export type AuthStatus = "authenticated" | "unauthenticated" | "unknown";

export interface ProfileSummary {
  name: string;
  dir: string;
  meta: ProfileMetaResult;
  authStatus: AuthStatus;
}

export type CreateProfileResult =
  | { status: "created"; dir: string; meta: ProfileMeta }
  /** Left untouched; phase 4 decides whether this is a resume or a conflict. */
  | { status: "exists"; dir: string; existing: ProfileMetaResult };

export interface DeleteProfileResult {
  dir: string;
  /** False when the directory was already gone. */
  existed: boolean;
}

function metaPath(dir: string): string {
  return path.join(dir, PROFILE_META_FILENAME);
}

/**
 * `profile.json` lives inside a directory the harness writes to freely, so it is
 * untrusted input: every field is re-validated, and the directory name on disk —
 * not the file — decides which profile this is.
 */
export function readProfileMeta(dir: string): ProfileMetaResult {
  let raw: string;
  try {
    raw = fs.readFileSync(metaPath(dir), "utf8");
  } catch {
    return { status: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: "invalid", reason: `not valid JSON: ${(error as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "invalid", reason: "expected a JSON object" };
  }

  const candidate = parsed as Record<string, unknown>;
  const dirName = path.basename(dir);
  const harnessName = path.basename(path.dirname(dir));

  try {
    if (typeof candidate.harness !== "string" || !findHarness(candidate.harness)) {
      throw new ValidationError(`unknown harness ${JSON.stringify(candidate.harness)}`);
    }
    if (candidate.harness !== harnessName) {
      throw new ValidationError(
        `harness ${JSON.stringify(candidate.harness)} does not match directory ${harnessName}`,
      );
    }

    const name = validateProfileName(candidate.name);
    if (name !== dirName) {
      throw new ValidationError(`name ${JSON.stringify(name)} does not match directory ${dirName}`);
    }

    const alias = validateAliasName(candidate.alias);
    const rcFile = validateRcPath(candidate.rcFile, os.homedir());

    if (typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt))) {
      throw new ValidationError(`createdAt is not an ISO 8601 timestamp`);
    }

    return {
      status: "ok",
      meta: { harness: candidate.harness, name, alias, rcFile, createdAt: candidate.createdAt },
    };
  } catch (error) {
    return { status: "invalid", reason: (error as Error).message };
  }
}

/**
 * Presence of the credentials file is the only signal available on disk. macOS
 * keeps credentials in Keychain instead, so it reports unknown rather than a
 * confident wrong answer. win32 stays unknown too: manual smoke (plan phase 3)
 * did not exercise a real `/login`, so whether `.credentials.json` lands in the
 * profile dir there is still unproven — guessing would repeat the exact mistake
 * that got macOS excluded.
 */
export function detectAuthStatus(
  adapter: HarnessAdapter,
  dir: string,
  platform: NodeJS.Platform,
): AuthStatus {
  if (platform !== "linux") {
    return "unknown";
  }
  return fs.existsSync(path.join(dir, adapter.credentialsFile))
    ? "authenticated"
    : "unauthenticated";
}

export function createProfile(
  adapter: HarnessAdapter,
  name: string,
  alias: string,
  rcFile: string,
): CreateProfileResult {
  const validName = validateProfileName(name);
  const validAlias = validateAliasName(alias);
  const validRcFile = validateRcPath(rcFile, os.homedir());

  const dir = assertInsideStore(profileDir(adapter.name, validName));

  if (fs.existsSync(dir)) {
    return { status: "exists", dir, existing: readProfileMeta(dir) };
  }

  const meta: ProfileMeta = {
    harness: adapter.name,
    name: validName,
    alias: validAlias,
    rcFile: validRcFile,
    createdAt: new Date().toISOString(),
  };

  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  fs.writeFileSync(metaPath(dir), `${JSON.stringify(meta, null, 2)}\n`, { mode: FILE_MODE });

  return { status: "created", dir, meta };
}

/** Never throws for one broken profile — a bad directory must stay listable. */
export function listProfiles(adapter: HarnessAdapter): ProfileSummary[] {
  const root = harnessDir(adapter.name);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name);
      return {
        name: entry.name,
        dir,
        meta: readProfileMeta(dir),
        authStatus: detectAuthStatus(adapter, dir, process.platform),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteProfile(adapter: HarnessAdapter, name: string): DeleteProfileResult {
  const validName = validateProfileName(name);
  const target = profileDir(adapter.name, validName);

  if (!fs.existsSync(target)) {
    return { dir: target, existed: false };
  }

  const dir = assertInsideStore(target, { mustBeExistingDir: true });
  fs.rmSync(dir, { recursive: true, force: true });

  if (fs.existsSync(dir)) {
    throw new Error(`failed to delete ${dir}: still present after removal`);
  }
  return { dir, existed: true };
}
