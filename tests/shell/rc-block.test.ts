import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { backupsDirFor } from "../../src/paths";
import {
  type AliasEntry,
  BLOCK_VERSION,
  type HostPaths,
  blockEndMarker,
  blockStartMarker,
  detectLineEnding,
  findCollision,
  findOrphanEntries,
  hasAlias,
  hostPathsFor,
  parseAliasLine,
  parseBlock,
  readBlock,
  removeAlias,
  renderAliasLine,
  upsertAlias,
} from "../../src/shell/rc-block";
import { ValidationError } from "../../src/validate";

let home: string;
let host: HostPaths;
let rcPath: string;

const RC_PROLOGUE = "# my shell config\nexport PATH=\"$PATH:/opt/bin\"\nalias ll='ls -la'\n";

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asp-rc-")));
  host = hostPathsFor(home, "linux");
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

function read(): string {
  return fs.readFileSync(rcPath, "utf8");
}

function backupNames(): string[] {
  try {
    return fs.readdirSync(backupsDirFor(home)).sort();
  } catch {
    return [];
  }
}

describe("rendering and parsing", () => {
  test("renders the documented alias shape with a $HOME-relative path", () => {
    expect(renderAliasLine(entry("ccwork", "work"), host)).toBe(
      `alias ccwork='CLAUDE_CONFIG_DIR="$HOME/.agent-switch-profiles/claude/work" claude'`,
    );
  });

  // Guards F2: the rendered `$HOME` must come back as a real path, or every
  // profile looks orphaned.
  test("round-trips a rendered line back to an absolute path", () => {
    const original = entry("ccwork", "work");
    const parsed = parseAliasLine(renderAliasLine(original, host), host);

    expect(parsed).toEqual(original);
    expect(path.isAbsolute(parsed?.profileDir ?? "")).toBe(true);
    expect(parsed?.profileDir).not.toContain("$HOME");
  });

  test("parses a hand-written absolute path too", () => {
    const line = `alias ccwork='CLAUDE_CONFIG_DIR="${path.join(home, "custom")}" claude'`;
    expect(parseAliasLine(line, host)?.profileDir).toBe(path.join(home, "custom"));
  });

  test("ignores lines that are not asp aliases", () => {
    expect(parseAliasLine("alias ll='ls -la'", host)).toBeNull();
    expect(parseAliasLine("export FOO=bar", host)).toBeNull();
    expect(parseAliasLine("", host)).toBeNull();
  });

  test("refuses an alias name it would never have written", () => {
    expect(parseAliasLine(`alias BAD='CLAUDE_CONFIG_DIR="$HOME/x" claude'`, host)).toBeNull();
  });

  test("refuses a path containing a newline", () => {
    const broken = { ...entry("ccwork", "work"), profileDir: "/tmp/a\nb" };
    expect(() => renderAliasLine(broken, host)).toThrow(ValidationError);
  });

  test("detects line endings", () => {
    expect(detectLineEnding("a\nb\n")).toBe("\n");
    expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
  });
});

// F9: the home directory is handed to us by the OS and may contain anything.
describe("hostile home directories", () => {
  const nasty = ["o'brien", "with space", "dollar$sign", "back`tick", 'quote"mark', "semi;colon"];

  test.each(nasty)("renders a line bash can parse when home contains %p", (segment) => {
    const hostileHome = path.join(home, segment);
    const hostileHost = hostPathsFor(hostileHome, "linux");
    const hostile: AliasEntry = {
      alias: "ccwork",
      profileDir: path.join(hostileHome, ".agent-switch-profiles", "claude", "work"),
      envVar: "CLAUDE_CONFIG_DIR",
      binary: "claude",
    };

    const line = renderAliasLine(hostile, hostileHost);
    const syntax = spawnSync("bash", ["-n"], { input: line });
    expect(syntax.status).toBe(0);

    expect(parseAliasLine(line, hostileHost)).toEqual(hostile);
  });

  test("a hostile home cannot smuggle a command into the alias", () => {
    const hostileHome = path.join(home, "x$(touch /tmp/asp-pwned)y");
    const hostile: AliasEntry = {
      alias: "ccwork",
      profileDir: path.join(hostileHome, "profile"),
      envVar: "CLAUDE_CONFIG_DIR",
      binary: "claude",
    };
    // Not under its own home, so the absolute form is rendered and escaped.
    const line = renderAliasLine(hostile, host);

    const probe = spawnSync("bash", ["-c", `${line}\nalias ccwork`], { encoding: "utf8" });
    expect(probe.status).toBe(0);
    expect(fs.existsSync("/tmp/asp-pwned")).toBe(false);
    expect(probe.stdout).toContain("$(touch /tmp/asp-pwned)");
  });
});

describe("upsertAlias", () => {
  test("appends a block and leaves earlier content byte-for-byte", () => {
    const result = upsertAlias(rcPath, host, entry("ccwork", "work"));

    expect(result.changed).toBe(true);
    expect(read().startsWith(RC_PROLOGUE)).toBe(true);
    expect(read()).toContain(blockStartMarker(BLOCK_VERSION));
    expect(read()).toContain(blockEndMarker(BLOCK_VERSION));
  });

  test("is idempotent: repeating it changes neither bytes nor mtime", () => {
    upsertAlias(rcPath, host, entry("ccwork", "work"));
    const afterFirst = read();
    const stat = fs.statSync(rcPath);

    for (let index = 0; index < 3; index += 1) {
      const repeat = upsertAlias(rcPath, host, entry("ccwork", "work"));
      expect(repeat.changed).toBe(false);
      expect(repeat.backupPath).toBeNull();
    }

    expect(read()).toBe(afterFirst);
    expect(fs.statSync(rcPath).mtimeMs).toBe(stat.mtimeMs);
    expect(read().match(/asp managed block/g)).toHaveLength(2);
  });

  test("keeps one block for many aliases, sorted for a stable diff", () => {
    upsertAlias(rcPath, host, entry("ccwork", "work"));
    upsertAlias(rcPath, host, entry("ccpersonal", "personal"));
    upsertAlias(rcPath, host, entry("ccclient", "client"));

    expect(read().match(/asp managed block/g)).toHaveLength(2);
    const block = readBlock(rcPath, host);
    expect(block.entries.map((item) => item.alias)).toEqual(["ccclient", "ccpersonal", "ccwork"]);
  });

  test("replaces an existing alias rather than duplicating it", () => {
    upsertAlias(rcPath, host, entry("ccwork", "work"));
    upsertAlias(rcPath, host, entry("ccwork", "work-2"));

    const block = readBlock(rcPath, host);
    expect(block.entries).toHaveLength(1);
    expect(block.entries[0]?.profileDir).toBe(
      path.join(home, ".agent-switch-profiles", "claude", "work-2"),
    );
  });

  test("creates the rc file when it does not exist yet", () => {
    const fresh = path.join(home, ".zshrc");
    upsertAlias(fresh, host, entry("ccwork", "work"));

    expect(hasAlias(readBlock(fresh, host), "ccwork")).toBe(true);
  });

  test("preserves unknown lines inside the block", () => {
    upsertAlias(rcPath, host, entry("ccwork", "work"));
    const withComment = read().replace(
      blockEndMarker(BLOCK_VERSION),
      `# hand-written note\n${blockEndMarker(BLOCK_VERSION)}`,
    );
    fs.writeFileSync(rcPath, withComment);

    upsertAlias(rcPath, host, entry("ccother", "other"));

    expect(read()).toContain("# hand-written note");
    expect(readBlock(rcPath, host).unknownLines).toEqual(["# hand-written note"]);
  });
});

describe("removeAlias", () => {
  test("drops the whole block once the last entry goes", () => {
    upsertAlias(rcPath, host, entry("ccwork", "work"));
    removeAlias(rcPath, host, "ccwork");

    expect(read()).toBe(RC_PROLOGUE);
    expect(read()).not.toContain("asp managed block");
  });

  test("keeps the block while other entries remain", () => {
    upsertAlias(rcPath, host, entry("ccwork", "work"));
    upsertAlias(rcPath, host, entry("ccpersonal", "personal"));
    removeAlias(rcPath, host, "ccwork");

    const block = readBlock(rcPath, host);
    expect(block.entries.map((item) => item.alias)).toEqual(["ccpersonal"]);
    expect(read().startsWith(RC_PROLOGUE)).toBe(true);
  });

  test("removing an absent alias is a no-op", () => {
    const before = read();
    expect(removeAlias(rcPath, host, "ccnope").changed).toBe(false);
    expect(read()).toBe(before);
  });
});
