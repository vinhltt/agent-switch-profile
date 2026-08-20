import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  LIST_SCHEMA_VERSION,
  type Listing,
  type WarningCode,
  buildListing,
  renderTable,
} from "../../src/commands/list";
import { claudeAdapter } from "../../src/harness/claude";
import { checkStoreRootPermissions, profileDir } from "../../src/paths";
import { PROFILE_META_FILENAME, createProfile, listProfiles } from "../../src/profile-store";
import { readBlock, upsertAlias } from "../../src/shell/rc-block";

import { createTempHome, type TempHome } from "../helpers/temp-home";

let tmp: TempHome;

beforeEach(() => {
  tmp = createTempHome();
});
afterEach(() => {
  tmp.cleanup();
});

function makeProfile(name: string, alias: string): string {
  const created = createProfile(claudeAdapter, name, alias, tmp.rcFile);
  upsertAlias(tmp.rcFile, tmp.host, {
    alias,
    profileDir: profileDir("claude", name),
    envVar: claudeAdapter.configEnvVar,
    binary: claudeAdapter.binary,
  });
  return created.dir;
}

function listing(globalConfigDir?: string, binaryFound = true): Listing {
  return buildListing({
    adapter: claudeAdapter,
    block: readBlock(tmp.rcFile, tmp.host),
    profiles: listProfiles(claudeAdapter),
    storePermissions: checkStoreRootPermissions("linux"),
    globalConfigDir,
    binaryFound,
  });
}

function codes(result: Listing): WarningCode[] {
  return result.warnings.map((warning) => warning.code);
}

const AUTH_VALUES = ["authenticated", "unauthenticated", "unknown", "invalid"];

describe("buildListing contract", () => {
  test("every required field is present and typed as promised", () => {
    makeProfile("work", "ccwork");
    const result = listing();

    expect(result.schemaVersion).toBe(LIST_SCHEMA_VERSION);
    expect(result.harness).toBe("claude");
    expect(result.profiles).toHaveLength(1);

    const [profile] = result.profiles;
    expect(typeof profile?.name).toBe("string");
    expect(typeof profile?.alias).toBe("string");
    expect(path.isAbsolute(profile?.dir ?? "")).toBe(true);
    expect(AUTH_VALUES).toContain(profile?.authStatus as string);
    expect(typeof profile?.aliasInRc).toBe("boolean");
    expect(Number.isNaN(Date.parse(profile?.createdAt ?? ""))).toBe(false);
  });

  test("every warning carries a code and a profile field", () => {
    fs.mkdirSync(profileDir("claude", "ghost"), { recursive: true });
    for (const warning of listing().warnings) {
      expect(typeof warning.code).toBe("string");
      expect(typeof warning.message).toBe("string");
      expect(warning).toHaveProperty("profile");
    }
  });

  test("is empty and warning-free before anything exists", () => {
    const result = listing();
    expect(result.profiles).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("sorts profiles by name", () => {
    makeProfile("zeta", "cczeta");
    makeProfile("alpha", "ccalpha");
    expect(listing().profiles.map((profile) => profile.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("warnings", () => {
  test("GLOBAL_CONFIG_DIR when the env var is set in this shell", () => {
    makeProfile("work", "ccwork");
    expect(codes(listing("/somewhere/else"))).toContain("GLOBAL_CONFIG_DIR");
    expect(codes(listing())).not.toContain("GLOBAL_CONFIG_DIR");
  });

  test("MISSING_ALIAS when a directory has no alias pointing at it", () => {
    fs.mkdirSync(profileDir("claude", "ghost"), { recursive: true });
    const result = listing();

    expect(codes(result)).toContain("MISSING_ALIAS");
    expect(result.warnings.find((w) => w.code === "MISSING_ALIAS")?.profile).toBe("ghost");
    expect(result.profiles[0]?.aliasInRc).toBe(false);
  });

  test("ORPHAN_ALIAS when the alias outlives its directory", () => {
    const dir = makeProfile("work", "ccwork");
    fs.rmSync(dir, { recursive: true, force: true });

    expect(codes(listing())).toContain("ORPHAN_ALIAS");
  });

  test("INVALID_PROFILE when the metadata cannot be trusted", () => {
    const dir = makeProfile("work", "ccwork");
    fs.writeFileSync(path.join(dir, PROFILE_META_FILENAME), "{ broken");

    const result = listing();
    expect(codes(result)).toContain("INVALID_PROFILE");
    expect(result.profiles[0]?.authStatus).toBe("invalid");
  });

  test("LOOSE_PERMISSIONS when the store is readable by others", () => {
    makeProfile("work", "ccwork");
    expect(codes(listing())).not.toContain("LOOSE_PERMISSIONS");

    fs.chmodSync(tmp.store, 0o755);
    expect(codes(listing())).toContain("LOOSE_PERMISSIONS");
  });

  test("BINARY_NOT_FOUND when the harness binary is not on PATH", () => {
    expect(codes(listing(undefined, true))).not.toContain("BINARY_NOT_FOUND");
    expect(codes(listing(undefined, false))).toContain("BINARY_NOT_FOUND");
  });

  // Hostile metadata must not decide what the user is told to run.
  test("reports the alias that actually runs, not the one recorded", () => {
    const dir = makeProfile("work", "ccwork");
    fs.writeFileSync(
      path.join(dir, PROFILE_META_FILENAME),
      JSON.stringify({
        harness: "claude",
        name: "work",
        alias: "cc; rm -rf ~",
        rcFile: "/etc/passwd",
        createdAt: new Date().toISOString(),
      }),
    );

    const result = listing();
    expect(result.profiles[0]?.alias).toBe("ccwork");
    expect(result.profiles[0]?.authStatus).toBe("invalid");
  });
});

describe("renderTable", () => {
  test("includes every column and one row per profile", () => {
    makeProfile("work", "ccwork");
    const table = renderTable(listing());

    for (const header of ["NAME", "ALIAS", "AUTH", "IN RC", "PATH"]) {
      expect(table).toContain(header);
    }
    expect(table).toContain("ccwork");
    expect(table.trimEnd().split("\n")).toHaveLength(2);
  });

  test("says how to get started when there is nothing to show", () => {
    expect(renderTable(listing())).toContain("asp create");
  });
});
