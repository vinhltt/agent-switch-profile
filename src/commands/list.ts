import type { Command } from "commander";
import * as os from "node:os";
import pc from "picocolors";

import type { HarnessAdapter } from "../harness/types";
import { checkStoreRootPermissions } from "../paths";
import { type AuthStatus, listProfiles } from "../profile-store";
import { type RcBlock, findOrphanEntries, readBlock } from "../shell/rc-block";

import { type GlobalOptions, resolveHarness, resolveRcPath } from "./shared";

/** Bump only for a breaking change; consumers pin against it. */
export const LIST_SCHEMA_VERSION = 1;

export type WarningCode =
  | "GLOBAL_CONFIG_DIR"
  | "ORPHAN_ALIAS"
  | "MISSING_ALIAS"
  | "INVALID_PROFILE"
  | "LOOSE_PERMISSIONS";

export interface ListWarning {
  code: WarningCode;
  message: string;
  profile: string | null;
}

export interface ListedProfile {
  name: string;
  alias: string | null;
  dir: string;
  authStatus: AuthStatus | "invalid";
  aliasInRc: boolean;
  createdAt: string | null;
}

export interface Listing {
  schemaVersion: number;
  harness: string;
  profiles: ListedProfile[];
  warnings: ListWarning[];
}

export interface ListingSources {
  adapter: HarnessAdapter;
  block: RcBlock;
  profiles: ReturnType<typeof listProfiles>;
  storePermissions: ReturnType<typeof checkStoreRootPermissions>;
  /** `process.env[adapter.configEnvVar]`, read by the caller. */
  globalConfigDir: string | undefined;
}

export function buildListing(sources: ListingSources): Listing {
  const { adapter, block, profiles } = sources;
  const warnings: ListWarning[] = [];

  if (sources.globalConfigDir) {
    warnings.push({
      code: "GLOBAL_CONFIG_DIR",
      message:
        `${adapter.configEnvVar} is set in this shell (${sources.globalConfigDir}), so plain ` +
        `${adapter.binary} uses it. The aliases below still win, because they set it per command.`,
      profile: null,
    });
  }

  if (sources.storePermissions?.loose) {
    warnings.push({
      code: "LOOSE_PERMISSIONS",
      message:
        `the profile store is mode ${sources.storePermissions.mode.toString(8)}; it holds ` +
        `credentials and should be 700. Run: chmod 700 on it.`,
      profile: null,
    });
  }

  const listed: ListedProfile[] = profiles.map((profile) => {
    const entry = block.entries.find((candidate) => candidate.profileDir === profile.dir);
    const meta = profile.meta.status === "ok" ? profile.meta.meta : undefined;

    if (profile.meta.status === "invalid") {
      warnings.push({
        code: "INVALID_PROFILE",
        message: `${profile.name}: profile.json is unusable (${profile.meta.reason})`,
        profile: profile.name,
      });
    }

    if (!entry) {
      warnings.push({
        code: "MISSING_ALIAS",
        message:
          `${profile.name}: the profile directory exists but no alias points at it — ` +
          `a create was interrupted. Run create again to finish it.`,
        profile: profile.name,
      });
    }

    return {
      name: profile.name,
      // Prefer the alias that actually runs over the one merely recorded.
      alias: entry?.alias ?? meta?.alias ?? null,
      dir: profile.dir,
      authStatus: profile.meta.status === "invalid" ? "invalid" : profile.authStatus,
      aliasInRc: Boolean(entry),
      createdAt: meta?.createdAt ?? null,
    };
  });

  for (const orphan of findOrphanEntries(block)) {
    warnings.push({
      code: "ORPHAN_ALIAS",
      message:
        `alias ${orphan.alias} points at ${orphan.profileDir}, which no longer exists. ` +
        `Run delete to remove the alias.`,
      profile: null,
    });
  }

  return {
    schemaVersion: LIST_SCHEMA_VERSION,
    harness: adapter.name,
    profiles: listed,
    warnings,
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

const AUTH_COLOURS: Record<string, (value: string) => string> = {
  authenticated: pc.green,
  unauthenticated: pc.yellow,
  unknown: pc.dim,
  invalid: pc.red,
};

export function renderTable(listing: Listing): string {
  if (listing.profiles.length === 0) {
    return `no ${listing.harness} profiles yet — create one with: asp create <name>\n`;
  }

  const headers = ["NAME", "ALIAS", "AUTH", "IN RC", "PATH"];
  const rows = listing.profiles.map((profile) => [
    profile.name,
    profile.alias ?? "-",
    profile.authStatus,
    profile.aliasInRc ? "yes" : "no",
    profile.dir,
  ]);

  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] as string).length)),
  );

  const lines = [
    pc.dim(headers.map((header, column) => pad(header, widths[column] as number)).join("  ")),
    ...rows.map((row) =>
      row
        .map((cell, column) => {
          const padded = pad(cell as string, widths[column] as number);
          return column === 2 ? (AUTH_COLOURS[cell as string] ?? ((v: string) => v))(padded) : padded;
        })
        .join("  ")
        .trimEnd(),
    ),
  ];

  return `${lines.join("\n")}\n`;
}

interface ListOptions {
  json?: boolean;
}

export function register(program: Command): void {
  program
    .command("list")
    .description("list profiles with their alias and auth status")
    .option("--json", "emit machine-readable output on stdout")
    .option("--rc <path>", "shell rc file holding the managed block")
    .action((options: ListOptions & { rc?: string }, command: Command) => {
      const adapter = resolveHarness(command.optsWithGlobals<GlobalOptions>());
      const homeDir = os.homedir();
      const rc = resolveRcPath(options.rc, undefined, homeDir, process.env.SHELL);

      const listing = buildListing({
        adapter,
        block: readBlock(rc.rcPath, homeDir),
        profiles: listProfiles(adapter),
        storePermissions: checkStoreRootPermissions(),
        globalConfigDir: process.env[adapter.configEnvVar],
      });

      if (options.json) {
        // stdout carries JSON and nothing else, so it can be piped straight in.
        process.stdout.write(`${JSON.stringify(listing, null, 2)}\n`);
        for (const warning of listing.warnings) {
          process.stderr.write(`${pc.yellow("!")} ${warning.code}: ${warning.message}\n`);
        }
        return;
      }

      process.stdout.write(renderTable(listing));
      for (const warning of listing.warnings) {
        process.stderr.write(`\n${pc.yellow("!")} ${warning.message}\n`);
      }
    });
}
