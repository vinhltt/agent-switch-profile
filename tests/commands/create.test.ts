import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  type CreateEffects,
  type CreateObservation,
  defaultCreateEffects,
  executeCreate,
  observeCreate,
  planCreate,
} from "../../src/commands/create";
import { claudeAdapter } from "../../src/harness/claude";
import { profileDir } from "../../src/paths";
import { PROFILE_META_FILENAME, createProfile, readProfileMeta } from "../../src/profile-store";
import { hasAlias, readBlock, upsertAlias } from "../../src/shell/rc-block";
import { ValidationError } from "../../src/validate";

import { createTempHome, type TempHome } from "../helpers/temp-home";

let tmp: TempHome;

beforeEach(() => {
  tmp = createTempHome();
});
afterEach(() => {
  tmp.cleanup();
});

const emptyState: CreateObservation = {
  dirExists: false,
  meta: { status: "missing" },
  entryForAlias: undefined,
  collisionOutsideBlock: null,
};

function planWith(state: Partial<CreateObservation>, requestedAlias?: string) {
  return planCreate({
    name: "work",
    requestedAlias,
    defaultAlias: "ccwork",
    profileDir: profileDir("claude", "work"),
    state: { ...emptyState, ...state },
  });
}

describe("planCreate", () => {
  test("creates a new profile with the default alias", () => {
    expect(planWith({})).toEqual({ kind: "create", alias: "ccwork" });
  });

  test("prefers an explicitly requested alias", () => {
    expect(planWith({}, "ccjob")).toEqual({ kind: "create", alias: "ccjob" });
  });

  test("refuses an alias that is not shell-safe, before anything is created", () => {
    expect(() => planWith({}, "cc;rm -rf /")).toThrow(ValidationError);
  });

  test("refuses an alias already defined outside the managed block", () => {
    expect(() => planWith({ collisionOutsideBlock: "alias ccwork='something'" })).toThrow(
      /outside the asp block/,
    );
  });

  test("refuses an alias already pointing at a different profile", () => {
    expect(() =>
      planWith({
        entryForAlias: {
          alias: "ccwork",
          profileDir: "/elsewhere",
          envVar: "CLAUDE_CONFIG_DIR",
          binary: "claude",
        },
      }),
    ).toThrow(/already points at/);
  });

  test("refuses a directory whose metadata cannot be trusted", () => {
    expect(() =>
      planWith({ dirExists: true, meta: { status: "invalid", reason: "bad name" } }),
    ).toThrow(/unusable/);
  });

  // F11: a run that died between mkdir and the rc write must be finishable.
  test("resumes when the directory exists but the alias never landed", () => {
    const action = planWith({
      dirExists: true,
      meta: {
        status: "ok",
        meta: {
          harness: "claude",
          name: "work",
          alias: "ccwork",
          rcFile: tmp.rcFile,
          createdAt: new Date().toISOString(),
        },
      },
    });

    expect(action.kind).toBe("resume");
    expect(action.alias).toBe("ccwork");
  });

  test("reports an already complete profile as up to date", () => {
    const action = planWith({
      dirExists: true,
      meta: {
        status: "ok",
        meta: {
          harness: "claude",
          name: "work",
          alias: "ccwork",
          rcFile: tmp.rcFile,
          createdAt: new Date().toISOString(),
        },
      },
      entryForAlias: {
        alias: "ccwork",
        profileDir: profileDir("claude", "work"),
        envVar: "CLAUDE_CONFIG_DIR",
        binary: "claude",
      },
    });

    expect(action).toEqual({ kind: "up-to-date", alias: "ccwork" });
  });

  test("refuses to re-alias an existing profile", () => {
    expect(() =>
      planWith(
        {
          dirExists: true,
          meta: {
            status: "ok",
            meta: {
              harness: "claude",
              name: "work",
              alias: "ccwork",
              rcFile: tmp.rcFile,
              createdAt: new Date().toISOString(),
            },
          },
        },
        "ccother",
      ),
    ).toThrow(/already uses alias/);
  });
});

describe("observeCreate", () => {
  test("reads state from disk without changing it", () => {
    const before = fs.readFileSync(tmp.rcFile, "utf8");
    const state = observeCreate(
      claudeAdapter,
      "work",
      "ccwork",
      profileDir("claude", "work"),
      tmp.rcFile,
      tmp.home,
    );

    expect(state).toMatchObject({ dirExists: false, collisionOutsideBlock: null });
    expect(state.meta.status).toBe("missing");
    expect(fs.readFileSync(tmp.rcFile, "utf8")).toBe(before);
  });

  test("spots an alias the user defined outside the block", () => {
    fs.appendFileSync(tmp.rcFile, "alias ccwork='echo hi'\n");
    const state = observeCreate(
      claudeAdapter,
      "work",
      "ccwork",
      profileDir("claude", "work"),
      tmp.rcFile,
      tmp.home,
    );
    expect(state.collisionOutsideBlock).toContain("echo hi");
  });
});

describe("executeCreate", () => {
  const input = () => ({
    adapter: claudeAdapter,
    name: "work",
    alias: "ccwork",
    dir: profileDir("claude", "work"),
    rcPath: tmp.rcFile,
    homeDir: tmp.home,
  });

  test("creates the directory, metadata and alias together", () => {
    const outcome = executeCreate(input());

    expect(outcome.resumed).toBe(false);
    expect(fs.existsSync(path.join(outcome.dir, PROFILE_META_FILENAME))).toBe(true);
    expect(hasAlias(readBlock(tmp.rcFile, tmp.home), "ccwork")).toBe(true);
    expect(outcome.rcWrite.backupPath).not.toBeNull();
  });

  test("finishes a half-created profile", () => {
    createProfile(claudeAdapter, "work", "ccwork", tmp.rcFile);
    const outcome = executeCreate(input());

    expect(outcome.resumed).toBe(true);
    expect(hasAlias(readBlock(tmp.rcFile, tmp.home), "ccwork")).toBe(true);
  });

  // The rc file is renamed into place before this failure, so rolling back has
  // to undo a write that already succeeded — not merely skip one.
  test("rolls back both the rc file and the directory when a later step fails", () => {
    const preImage = fs.readFileSync(tmp.rcFile, "utf8");
    const effects: CreateEffects = {
      ...defaultCreateEffects,
      verifyAlias: () => {
        throw new Error("verification blew up after the rename");
      },
    };

    expect(() => executeCreate(input(), effects)).toThrow(/verification blew up/);

    expect(fs.readFileSync(tmp.rcFile, "utf8")).toBe(preImage);
    expect(fs.existsSync(profileDir("claude", "work"))).toBe(false);
  });

  test("keeps a pre-existing profile when the rc write fails", () => {
    createProfile(claudeAdapter, "work", "ccwork", tmp.rcFile);
    const preImage = fs.readFileSync(tmp.rcFile, "utf8");

    const effects: CreateEffects = {
      ...defaultCreateEffects,
      upsertAlias: () => {
        throw new Error("rc write failed");
      },
    };

    expect(() => executeCreate(input(), effects)).toThrow(/rc write failed/);

    expect(fs.readFileSync(tmp.rcFile, "utf8")).toBe(preImage);
    // The directory predates this run, so rollback must not delete it.
    expect(readProfileMeta(profileDir("claude", "work")).status).toBe("ok");
  });

  test("removes an rc file it created when rolling back", () => {
    const fresh = path.join(tmp.home, ".zshrc");
    const effects: CreateEffects = {
      ...defaultCreateEffects,
      verifyAlias: () => {
        throw new Error("boom");
      },
    };

    expect(() => executeCreate({ ...input(), rcPath: fresh }, effects)).toThrow(/boom/);
    expect(fs.existsSync(fresh)).toBe(false);
  });

  test("reports a rollback that fails instead of hiding it", () => {
    const effects: CreateEffects = {
      ...defaultCreateEffects,
      upsertAlias: (rcPath, homeDir, entry) => {
        const result = upsertAlias(rcPath, homeDir, entry);
        // Make the rc file unrestorable by turning its directory read-only.
        fs.chmodSync(tmp.home, 0o500);
        return result;
      },
      verifyAlias: () => {
        throw new Error("boom");
      },
    };

    try {
      expect(() => executeCreate(input(), effects)).toThrow(/clean these up by hand/);
    } finally {
      fs.chmodSync(tmp.home, 0o700);
    }
  });
});
