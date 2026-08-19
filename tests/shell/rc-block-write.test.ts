import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { backupsDirFor } from "../../src/paths";
import {
  type AliasEntry,
  BLOCK_VERSION,
  blockEndMarker,
  blockStartMarker,
  findCollision,
  findOrphanEntries,
  readBlock,
  removeAlias,
  rewriteBlock,
  upsertAlias,
} from "../../src/shell/rc-block";
import { ValidationError } from "../../src/validate";

let home: string;
let rcPath: string;

const RC_PROLOGUE = "# my shell config\nexport PATH=\"$PATH:/opt/bin\"\n";

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asp-rcw-")));
  rcPath = path.join(home, ".bashrc");
  fs.writeFileSync(rcPath, RC_PROLOGUE);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function entry(alias: string, profile: string): AliasEntry {
  return {
    alias,
    profileDir: path.join(home, ".agent-switch-profiles", "claude", profile),
    envVar: "CLAUDE_CONFIG_DIR",
    binary: "claude",
  };
}

function backupNames(): string[] {
  try {
    return fs.readdirSync(backupsDirFor(home)).sort();
  } catch {
    return [];
  }
}

describe("file safety", () => {
  // F3: a rename over the link would replace it with a regular file and detach
  // the dotfiles repository that owns it.
  test("writes through a symlinked rc file and leaves it a symlink", () => {
    const real = path.join(home, "dotfiles-bashrc");
    fs.writeFileSync(real, RC_PROLOGUE);
    const link = path.join(home, ".zshrc");
    fs.symlinkSync(real, link);

    const result = upsertAlias(link, home, entry("ccwork", "work"));

    expect(result.realPath).toBe(real);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toContain("alias ccwork=");
  });

  test("preserves the file mode", () => {
    fs.chmodSync(rcPath, 0o600);
    upsertAlias(rcPath, home, entry("ccwork", "work"));
    expect(fs.statSync(rcPath).mode & 0o777).toBe(0o600);

    fs.chmodSync(rcPath, 0o644);
    upsertAlias(rcPath, home, entry("ccother", "other"));
    expect(fs.statSync(rcPath).mode & 0o777).toBe(0o644);
  });

  test("preserves CRLF line endings without duplicating the block", () => {
    fs.writeFileSync(rcPath, "# windows edited\r\nexport A=1\r\n");
    upsertAlias(rcPath, home, entry("ccwork", "work"));
    upsertAlias(rcPath, home, entry("ccother", "other"));

    const content = fs.readFileSync(rcPath, "utf8");
    expect(content).toContain(`${blockStartMarker(BLOCK_VERSION)}\r\n`);
    expect(content.match(/asp managed block/g)).toHaveLength(2);
    expect(content.split("\r\n").length - 1).toBe(content.split("\n").length - 1);
  });

  test("refuses an rc file with more than one hard link", () => {
    fs.linkSync(rcPath, path.join(home, "hardlink-copy"));
    expect(() => upsertAlias(rcPath, home, entry("ccwork", "work"))).toThrow(/hard link/);
    expect(fs.readFileSync(rcPath, "utf8")).toBe(RC_PROLOGUE);
  });

  // The alias must carry `$HOME`, not the expanded path, so a moved or renamed
  // home does not silently point every profile at a directory that is gone.
  test("stores the path as $HOME on disk while reporting it absolute", () => {
    upsertAlias(rcPath, home, entry("ccwork", "work"));

    const content = fs.readFileSync(rcPath, "utf8");
    expect(content).toContain('CLAUDE_CONFIG_DIR="$HOME/.agent-switch-profiles/claude/work"');
    expect(content).not.toContain(home + "/.agent-switch-profiles/claude/work");

    expect(readBlock(rcPath, home).entries[0]?.profileDir).toBe(
      path.join(home, ".agent-switch-profiles", "claude", "work"),
    );
  });

  test("aborts when the rc file changes between the read and the write", () => {
    expect(() =>
      rewriteBlock(rcPath, home, (block) => {
        // Another editor saving the file while asp holds the lock.
        fs.writeFileSync(rcPath, `${RC_PROLOGUE}# added by someone else\n`);
        return { ...block, present: true, entries: [entry("ccwork", "work")] };
      }),
    ).toThrow(/changed while asp was editing it/);

    expect(fs.readFileSync(rcPath, "utf8")).toBe(`${RC_PROLOGUE}# added by someone else\n`);
    // An aborted run leaves nothing behind, not even a backup of stale content.
    expect(backupNames()).toEqual([]);
  });

  test("leaves no temp file behind", () => {
    upsertAlias(rcPath, home, entry("ccwork", "work"));
    expect(fs.readdirSync(home).filter((name) => name.includes("asp-"))).toEqual([]);
  });
});

describe("backups", () => {
  test("writes a timestamped backup into the store, not next to the rc file", () => {
    const result = upsertAlias(rcPath, home, entry("ccwork", "work"));

    expect(result.backupPath).not.toBeNull();
    expect(result.backupPath?.startsWith(backupsDirFor(home))).toBe(true);
    expect(fs.readFileSync(result.backupPath as string, "utf8")).toBe(RC_PROLOGUE);

    expect(fs.readdirSync(home).filter((name) => name.includes(".asp.bak"))).toEqual([]);
    expect(fs.statSync(backupsDirFor(home)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(result.backupPath as string).mode & 0o777).toBe(0o600);
  });

  test("never overwrites an earlier backup", () => {
    upsertAlias(rcPath, home, entry("ccwork", "work"));
    upsertAlias(rcPath, home, entry("ccother", "other"));

    expect(backupNames()).toHaveLength(2);
    expect(new Set(backupNames()).size).toBe(2);
  });

  test("keeps only the five most recent", () => {
    for (let index = 0; index < 8; index += 1) {
      upsertAlias(rcPath, home, entry(`ccprofile${index}`, `profile${index}`));
    }
    expect(backupNames()).toHaveLength(5);
  });

  test("refuses to back up an empty rc file over a non-empty history", () => {
    upsertAlias(rcPath, home, entry("ccwork", "work"));
    fs.writeFileSync(rcPath, "");

    expect(() => upsertAlias(rcPath, home, entry("ccother", "other"))).toThrow(/earlier damage/);
    expect(backupNames()).toHaveLength(1);
  });
});

describe("damaged or unknown markers", () => {
  test("refuses a block with only an opening marker and writes nothing", () => {
    const damaged = `${RC_PROLOGUE}${blockStartMarker(BLOCK_VERSION)}\nalias ccwork='x'\n`;
    fs.writeFileSync(rcPath, damaged);

    expect(() => upsertAlias(rcPath, home, entry("ccother", "other"))).toThrow(ValidationError);
    expect(fs.readFileSync(rcPath, "utf8")).toBe(damaged);
    expect(backupNames()).toEqual([]);
  });

  test("refuses duplicated blocks", () => {
    upsertAlias(rcPath, home, entry("ccwork", "work"));
    fs.appendFileSync(
      rcPath,
      `${blockStartMarker(BLOCK_VERSION)}\n${blockEndMarker(BLOCK_VERSION)}\n`,
    );
    expect(() => readBlock(rcPath, home)).toThrow(/damaged/);
  });

  test("refuses a block written by a newer asp instead of rewriting it", () => {
    const future = `${RC_PROLOGUE}# >>> asp managed block v99 >>>\nalias ccx='y'\n# <<< asp managed block v99 <<<\n`;
    fs.writeFileSync(rcPath, future);

    expect(() => upsertAlias(rcPath, home, entry("ccwork", "work"))).toThrow(/Upgrade asp/);
    expect(fs.readFileSync(rcPath, "utf8")).toBe(future);
  });

  test("refuses a closing marker that precedes the opening one", () => {
    fs.writeFileSync(
      rcPath,
      `${blockEndMarker(BLOCK_VERSION)}\n${blockStartMarker(BLOCK_VERSION)}\n`,
    );
    expect(() => readBlock(rcPath, home)).toThrow(/closes before it opens/);
  });
});

describe("locking", () => {
  test("a nested write aborts instead of racing the outer one", () => {
    expect(() =>
      rewriteBlock(rcPath, home, (block) => {
        // Simulates a second asp process arriving mid-write.
        upsertAlias(rcPath, home, entry("ccinner", "inner"));
        return block;
      }),
    ).toThrow(/is editing/);

    expect(fs.readFileSync(rcPath, "utf8")).toBe(RC_PROLOGUE);
  });

  test("releases the lock after a successful write", () => {
    upsertAlias(rcPath, home, entry("ccwork", "work"));
    expect(fs.existsSync(`${rcPath}.asp.lock`)).toBe(false);
  });

  test("releases the lock after a failed write", () => {
    fs.writeFileSync(rcPath, `${blockStartMarker(BLOCK_VERSION)}\n`);
    expect(() => upsertAlias(rcPath, home, entry("ccwork", "work"))).toThrow();
    expect(fs.existsSync(`${rcPath}.asp.lock`)).toBe(false);
  });

  test("takes over a stale lock and says so", () => {
    fs.writeFileSync(`${rcPath}.asp.lock`, "999999\n");
    const old = Date.now() / 1000 - 60;
    fs.utimesSync(`${rcPath}.asp.lock`, old, old);

    const result = upsertAlias(rcPath, home, entry("ccwork", "work"));

    expect(result.changed).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/stale lock/);
  });
});

describe("inspection helpers", () => {
  test("finds an alias defined outside the block", () => {
    fs.writeFileSync(rcPath, `${RC_PROLOGUE}alias ccwork='something else'\n`);
    upsertAlias(rcPath, home, entry("ccother", "other"));

    const content = fs.readFileSync(rcPath, "utf8");
    expect(findCollision(content, "ccwork")).toContain("something else");
    expect(findCollision(content, "ccother")).toBeNull();
  });

  test("reports entries whose profile directory is gone", () => {
    upsertAlias(rcPath, home, entry("ccwork", "work"));
    upsertAlias(rcPath, home, entry("cclive", "live"));
    fs.mkdirSync(path.join(home, ".agent-switch-profiles", "claude", "live"), { recursive: true });

    const orphans = findOrphanEntries(readBlock(rcPath, home));
    expect(orphans.map((item) => item.alias)).toEqual(["ccwork"]);
  });
});
