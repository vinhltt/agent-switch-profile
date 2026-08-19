import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  type DeleteEffects,
  type DeleteObservation,
  defaultDeleteEffects,
  executeDelete,
  observeDelete,
  planDelete,
  recreationNotice,
} from "../../src/commands/delete";
import { CliError } from "../../src/commands/shared";
import { claudeAdapter } from "../../src/harness/claude";
import { profileDir } from "../../src/paths";
import { createProfile } from "../../src/profile-store";
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

function makeProfile(name: string, alias: string): string {
  const created = createProfile(claudeAdapter, name, alias, tmp.rcFile);
  upsertAlias(tmp.rcFile, tmp.home, {
    alias,
    profileDir: profileDir("claude", name),
    envVar: claudeAdapter.configEnvVar,
    binary: claudeAdapter.binary,
  });
  return created.dir;
}

const presentState: DeleteObservation = {
  dirExists: true,
  alias: "ccwork",
  liveProcesses: [],
};

function planWith(state: Partial<DeleteObservation>, force = false, interactive = true) {
  return planDelete({
    name: "work",
    force,
    interactive,
    state: { ...presentState, ...state },
  });
}

describe("planDelete", () => {
  test("deletes when confirmation is possible", () => {
    expect(planWith({})).toEqual({ kind: "delete", alias: "ccwork" });
  });

  // The hang this guards against was real: stdout was a TTY while stdin was not.
  test("refuses rather than waiting for input that cannot arrive", () => {
    expect(() => planWith({}, false, false)).toThrow(ValidationError);
    expect(() => planWith({}, false, false)).toThrow(/--force/);
  });

  test("proceeds non-interactively when forced", () => {
    expect(planWith({}, true, false)).toEqual({ kind: "delete", alias: "ccwork" });
  });

  test("refuses while a session is still using the profile", () => {
    expect(() => planWith({ liveProcesses: [4242] })).toThrow(CliError);
    expect(() => planWith({ liveProcesses: [4242] })).toThrow(/pid 4242/);
  });

  test("allows a forced delete over a running session", () => {
    expect(planWith({ liveProcesses: [4242] }, true).kind).toBe("delete");
  });

  test("clears a leftover alias when the directory is already gone", () => {
    expect(planWith({ dirExists: false })).toEqual({
      kind: "clear-orphan-alias",
      alias: "ccwork",
    });
  });

  test("has nothing to do when neither directory nor alias exists", () => {
    expect(planWith({ dirExists: false, alias: null })).toEqual({ kind: "nothing-to-do" });
  });
});

describe("recreationNotice", () => {
  test("says nothing when no process held the profile", () => {
    expect(recreationNotice("work", [])).toBeNull();
  });

  // Observed for real: the directory came back 14 seconds after a forced delete,
  // when the Claude Code process still holding it wrote its config on exit.
  test("names the processes and what to do about them", () => {
    const notice = recreationNotice("work", [4242, 4243]);
    expect(notice).toContain("4242, 4243");
    expect(notice).toContain("run delete again");
  });
});

describe("observeDelete", () => {
  test("finds the alias that points at the directory", () => {
    const dir = makeProfile("work", "ccwork");
    const state = observeDelete(claudeAdapter, dir, tmp.rcFile, tmp.home);

    expect(state).toMatchObject({ dirExists: true, alias: "ccwork" });
    expect(state.liveProcesses).toEqual([]);
  });
});

describe("executeDelete", () => {
  test("removes the directory and then the alias", () => {
    const dir = makeProfile("work", "ccwork");

    const outcome = executeDelete(
      claudeAdapter,
      "work",
      { kind: "delete", alias: "ccwork" },
      tmp.rcFile,
      tmp.home,
    );

    expect(outcome.removed?.existed).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(hasAlias(readBlock(tmp.rcFile, tmp.home), "ccwork")).toBe(false);
  });

  // Removing the credentials is the point; the alias is only a shortcut. An
  // alias removed while the directory survives would hide a live profile.
  test("keeps the alias when the directory cannot be removed", () => {
    const dir = makeProfile("work", "ccwork");
    const effects: DeleteEffects = {
      ...defaultDeleteEffects,
      deleteProfile: () => {
        throw new Error("EACCES: permission denied");
      },
    };

    expect(() =>
      executeDelete(
        claudeAdapter,
        "work",
        { kind: "delete", alias: "ccwork" },
        tmp.rcFile,
        tmp.home,
        effects,
      ),
    ).toThrow(/EACCES/);

    expect(fs.existsSync(dir)).toBe(true);
    expect(hasAlias(readBlock(tmp.rcFile, tmp.home), "ccwork")).toBe(true);
  });

  test("clears an orphan alias without touching the store", () => {
    const dir = makeProfile("work", "ccwork");
    fs.rmSync(dir, { recursive: true, force: true });

    const outcome = executeDelete(
      claudeAdapter,
      "work",
      { kind: "clear-orphan-alias", alias: "ccwork" },
      tmp.rcFile,
      tmp.home,
    );

    expect(outcome.removed).toBeNull();
    expect(outcome.aliasRemoved).toBe("ccwork");
    expect(hasAlias(readBlock(tmp.rcFile, tmp.home), "ccwork")).toBe(false);
  });

  test("restores the rc file to exactly what it was before the profile existed", () => {
    const before = fs.readFileSync(tmp.rcFile, "utf8");
    makeProfile("work", "ccwork");

    executeDelete(
      claudeAdapter,
      "work",
      { kind: "delete", alias: "ccwork" },
      tmp.rcFile,
      tmp.home,
    );

    expect(fs.readFileSync(tmp.rcFile, "utf8")).toBe(before);
  });

  test("leaves other profiles alone", () => {
    makeProfile("work", "ccwork");
    const keep = makeProfile("personal", "ccpersonal");

    executeDelete(
      claudeAdapter,
      "work",
      { kind: "delete", alias: "ccwork" },
      tmp.rcFile,
      tmp.home,
    );

    expect(fs.existsSync(path.join(keep, "profile.json"))).toBe(true);
    expect(hasAlias(readBlock(tmp.rcFile, tmp.home), "ccpersonal")).toBe(true);
  });
});
