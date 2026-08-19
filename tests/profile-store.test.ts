import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { claudeAdapter } from "../src/harness/claude";
import { harnessDir, profileDir, storeRoot } from "../src/paths";
import {
  PROFILE_META_FILENAME,
  createProfile,
  deleteProfile,
  detectAuthStatus,
  listProfiles,
  readProfileMeta,
} from "../src/profile-store";
import { ValidationError } from "../src/validate";

import { createTempHome, modeOf, type TempHome } from "./helpers/temp-home";

let tmp: TempHome;

beforeEach(() => {
  tmp = createTempHome();
});
afterEach(() => {
  tmp.cleanup();
});

function create(name: string, alias = `cc${name.replace(/-/g, "")}`) {
  return createProfile(claudeAdapter, name, alias, tmp.rcFile);
}

/** Overwrite profile.json with attacker-controlled content. */
function poison(dir: string, content: unknown): void {
  fs.writeFileSync(
    path.join(dir, PROFILE_META_FILENAME),
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

describe("createProfile", () => {
  test("creates the directory and metadata with owner-only permissions", () => {
    const result = create("work");

    expect(result.status).toBe("created");
    expect(result.dir).toBe(path.join(tmp.store, "claude", "work"));

    expect(modeOf(result.dir) & 0o077).toBe(0);
    expect(modeOf(path.join(result.dir, PROFILE_META_FILENAME))).toBe(0o600);
    expect(modeOf(harnessDir("claude")) & 0o077).toBe(0);
    expect(modeOf(storeRoot()) & 0o077).toBe(0);
  });

  test("records the metadata the plan specifies", () => {
    const result = create("work", "ccwork");
    if (result.status !== "created") throw new Error("expected created");

    expect(result.meta).toMatchObject({
      harness: "claude",
      name: "work",
      alias: "ccwork",
      rcFile: tmp.rcFile,
    });
    expect(Number.isNaN(Date.parse(result.meta.createdAt))).toBe(false);
  });

  test("reports an existing profile without touching it", () => {
    const first = create("work", "ccwork");
    if (first.status !== "created") throw new Error("expected created");
    const marker = path.join(first.dir, ".credentials.json");
    fs.writeFileSync(marker, "{}");

    const second = create("work", "ccother");

    expect(second.status).toBe("exists");
    expect(fs.existsSync(marker)).toBe(true);
    if (second.status !== "exists" || second.existing.status !== "ok") {
      throw new Error("expected existing metadata to stay readable");
    }
    expect(second.existing.meta.alias).toBe("ccwork");
  });

  test.each(["..", "a/b", "../../etc", "Work", ""])(
    "refuses profile name %p before creating anything",
    (name) => {
      expect(() => create(name)).toThrow(ValidationError);
      expect(fs.existsSync(storeRoot())).toBe(false);
    },
  );

  test.each(["cc work", "cc;rm -rf /", "cc$(id)", "cc'x", "CC"])(
    "refuses alias %p before creating anything",
    (alias) => {
      expect(() => createProfile(claudeAdapter, "work", alias, tmp.rcFile)).toThrow(
        ValidationError,
      );
      expect(fs.existsSync(storeRoot())).toBe(false);
    },
  );

  test("refuses to write through a symlink pointing at another profile", () => {
    const real = create("real", "ccreal");
    fs.symlinkSync(real.dir, profileDir("claude", "work"));

    expect(() => create("work", "ccwork")).toThrow(/symlink/);
    const meta = fs.readFileSync(path.join(real.dir, PROFILE_META_FILENAME), "utf8");
    expect(meta).toContain('"ccreal"');
  });

  test("refuses an rc file outside the home directory", () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asp-out-")));
    fs.writeFileSync(path.join(outside, ".bashrc"), "");
    try {
      expect(() => createProfile(claudeAdapter, "work", "ccwork", path.join(outside, ".bashrc")))
        .toThrow(ValidationError);
      expect(fs.existsSync(storeRoot())).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("readProfileMeta", () => {
  test("reports a directory with no metadata as missing", () => {
    const dir = profileDir("claude", "work");
    fs.mkdirSync(dir, { recursive: true });
    expect(readProfileMeta(dir)).toEqual({ status: "missing" });
  });

  test("reports malformed JSON as invalid", () => {
    const result = create("work");
    poison(result.dir, "{ definitely not json");
    expect(readProfileMeta(result.dir).status).toBe("invalid");
  });

  test("reports a JSON array as invalid", () => {
    const result = create("work");
    poison(result.dir, []);
    expect(readProfileMeta(result.dir).status).toBe("invalid");
  });

  // The harness owns this directory, so a hostile profile.json is in scope.
  test.each([
    ["alias carrying shell metacharacters", { alias: "ccwork; rm -rf ~" }],
    ["alias with a newline", { alias: "ccwork\nalias evil=x" }],
    ["name disagreeing with the directory", { name: "other" }],
    ["name that is a traversal", { name: "../../etc" }],
    ["harness disagreeing with the directory", { harness: "codex" }],
    ["rcFile outside the home directory", { rcFile: "/etc/bashrc" }],
    ["rcFile outside the allowlist", { rcFile: "AUTHORIZED_KEYS_PLACEHOLDER" }],
    ["createdAt that is not a timestamp", { createdAt: "yesterday" }],
    ["createdAt of the wrong type", { createdAt: 17 }],
  ])("rejects %s", (_label, override) => {
    const created = create("work", "ccwork");
    if (created.status !== "created") throw new Error("expected created");

    const patched: Record<string, unknown> = { ...created.meta, ...override };
    if (patched.rcFile === "AUTHORIZED_KEYS_PLACEHOLDER") {
      patched.rcFile = path.join(tmp.home, ".ssh", "authorized_keys");
    }
    poison(created.dir, patched);

    const result = readProfileMeta(created.dir);
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") throw new Error("unreachable");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("listProfiles", () => {
  test("returns an empty list before the store exists", () => {
    expect(listProfiles(claudeAdapter)).toEqual([]);
  });

  test("lists profiles sorted, and one broken profile does not hide the others", () => {
    create("alpha", "ccalpha");
    const broken = create("beta", "ccbeta");
    create("gamma", "ccgamma");
    poison(broken.dir, "{ broken");

    const listed = listProfiles(claudeAdapter);

    expect(listed.map((profile) => profile.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(listed[1]?.meta.status).toBe("invalid");
    expect(listed[0]?.meta.status).toBe("ok");
  });

  test("reads auth status from the credentials file", () => {
    const created = create("work", "ccwork");
    expect(listProfiles(claudeAdapter)[0]?.authStatus).toBe("unauthenticated");

    fs.writeFileSync(path.join(created.dir, ".credentials.json"), "{}");
    expect(listProfiles(claudeAdapter)[0]?.authStatus).toBe("authenticated");
  });

  test("does not guess auth status off Linux", () => {
    const created = create("work", "ccwork");
    fs.writeFileSync(path.join(created.dir, ".credentials.json"), "{}");

    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      expect(detectAuthStatus(claudeAdapter, created.dir)).toBe("unknown");
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});

describe("deleteProfile", () => {
  test("removes the directory and verifies it is gone", () => {
    const created = create("work", "ccwork");
    const result = deleteProfile(claudeAdapter, "work");

    expect(result).toEqual({ dir: created.dir, existed: true });
    expect(fs.existsSync(created.dir)).toBe(false);
  });

  test("is a no-op for a profile that is already gone", () => {
    expect(deleteProfile(claudeAdapter, "work").existed).toBe(false);
  });

  test.each(["..", "a/b", "../../etc"])("refuses traversal name %p", (name) => {
    expect(() => deleteProfile(claudeAdapter, name)).toThrow(ValidationError);
  });

  test("refuses a profile directory that is a symlink, leaving the target intact", () => {
    const victim = path.join(tmp.home, "precious");
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, "keep.txt"), "do not delete me");

    fs.mkdirSync(harnessDir("claude"), { recursive: true, mode: 0o700 });
    fs.symlinkSync(victim, profileDir("claude", "work"));

    expect(() => deleteProfile(claudeAdapter, "work")).toThrow(ValidationError);
    expect(fs.existsSync(path.join(victim, "keep.txt"))).toBe(true);
  });

  // Regression: resolving the path before checking for symlinks turns
  // `work -> real` into `real`, which passes every containment test and deletes
  // the wrong profile. The link must be refused on the literal path.
  test("refuses a symlink pointing at another profile inside the store", () => {
    const real = create("real", "ccreal");
    fs.symlinkSync(real.dir, profileDir("claude", "work"));

    expect(() => deleteProfile(claudeAdapter, "work")).toThrow(/symlink/);
    expect(fs.existsSync(path.join(real.dir, PROFILE_META_FILENAME))).toBe(true);
  });

  test("refuses when the harness directory itself is a symlink, leaving the target intact", () => {
    const victim = path.join(tmp.home, "precious");
    fs.mkdirSync(path.join(victim, "work"), { recursive: true });
    fs.writeFileSync(path.join(victim, "work", "keep.txt"), "do not delete me");

    fs.mkdirSync(storeRoot(), { recursive: true, mode: 0o700 });
    fs.symlinkSync(victim, harnessDir("claude"));

    expect(() => deleteProfile(claudeAdapter, "work")).toThrow(ValidationError);
    expect(fs.existsSync(path.join(victim, "work", "keep.txt"))).toBe(true);
  });
});
