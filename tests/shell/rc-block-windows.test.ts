import { describe, expect, test } from "bun:test";

import {
  type AliasEntry,
  hostPathsFor,
  parseAliasLine,
  parseBlock,
  renderAliasLine,
} from "../../src/shell/rc-block";

/**
 * win32 rendering must be verifiable without a Windows machine, so every path
 * here is a hand-written string literal — never `path.join`, which always
 * uses the real OS separator and would silently reintroduce the posix/win32
 * mismatch this file exists to guard against.
 */

const winHome = "C:\\Users\\vinh";
const winHost = hostPathsFor(winHome, "win32");

const posixHome = "/home/vinh";
const posixHost = hostPathsFor(posixHome, "linux");

function entry(profileDir: string): AliasEntry {
  return {
    alias: "ccwork",
    profileDir,
    envVar: "CLAUDE_CONFIG_DIR",
    binary: "claude",
  };
}

describe("hostPathsFor", () => {
  test("maps win32 to path.win32", () => {
    expect(winHost.platform).toBe("win32");
  });

  test("maps every other platform to path.posix", () => {
    expect(hostPathsFor(posixHome, "linux").platform).toBe("posix");
    expect(hostPathsFor(posixHome, "darwin").platform).toBe("posix");
  });
});

describe("win32 rendering", () => {
  test("renders an absolute backslash path, skipping the $HOME branch", () => {
    const profileDir = `${winHome}\\.agent-switch-profiles\\claude\\work`;
    const line = renderAliasLine(entry(profileDir), winHost);

    expect(line).toBe(
      `alias ccwork='CLAUDE_CONFIG_DIR="C:\\\\Users\\\\vinh\\\\.agent-switch-profiles\\\\claude\\\\work" claude'`,
    );
  });

  test("parses the rendered line back to the original backslash path", () => {
    const profileDir = `${winHome}\\.agent-switch-profiles\\claude\\work`;
    const line = renderAliasLine(entry(profileDir), winHost);
    const parsed = parseAliasLine(line, winHost);

    expect(parsed?.profileDir).toBe(profileDir);
  });

  test("still parses a hand-typed $HOME/... line", () => {
    const line = `alias ccwork='CLAUDE_CONFIG_DIR="$HOME/.agent-switch-profiles/claude/work" claude'`;
    const parsed = parseAliasLine(line, winHost);

    expect(parsed?.profileDir).toBe(`${winHome}\\.agent-switch-profiles\\claude\\work`);
  });

  test("still parses a hand-typed absolute backslash line outside home", () => {
    const line = `alias ccwork='CLAUDE_CONFIG_DIR="D:\\\\profiles\\\\work" claude'`;
    const parsed = parseAliasLine(line, winHost);

    expect(parsed?.profileDir).toBe("D:\\profiles\\work");
  });

  // path.win32.isAbsolute/normalize treat a leading "/c/..." as a path named
  // "c" under the current drive's root, not drive C: — a hand-written or
  // pre-Phase-1 line in that Git-Bash-style form must not be silently
  // reinterpreted and rewritten to the wrong path.
  test("refuses a posix-drive-style path instead of misreading it", () => {
    const line = `alias ccwork='CLAUDE_CONFIG_DIR="/c/Users/vinh/.agent-switch-profiles/claude/work" claude'`;
    expect(parseAliasLine(line, winHost)).toBeNull();
  });

  test("preserves that line byte-for-byte as an unknown line through a full parse", () => {
    const line = `alias ccwork='CLAUDE_CONFIG_DIR="/c/Users/vinh/.agent-switch-profiles/claude/work" claude'`;
    const content = `# >>> asp managed block v1 >>>\n${line}\n# <<< asp managed block v1 <<<\n`;
    const block = parseBlock(content, winHost);

    expect(block.entries).toEqual([]);
    expect(block.unknownLines).toEqual([line]);
  });
});

describe("round-trip: render -> parse -> render", () => {
  test("posix", () => {
    const profileDir = `${posixHome}/.agent-switch-profiles/claude/work`;
    const first = renderAliasLine(entry(profileDir), posixHost);
    const parsed = parseAliasLine(first, posixHost);
    const second = renderAliasLine(entry(parsed?.profileDir as string), posixHost);

    expect(second).toBe(first);
    expect(first).toContain("$HOME");
  });

  test("win32", () => {
    const profileDir = `${winHome}\\.agent-switch-profiles\\claude\\work`;
    const first = renderAliasLine(entry(profileDir), winHost);
    const parsed = parseAliasLine(first, winHost);
    const second = renderAliasLine(entry(parsed?.profileDir as string), winHost);

    expect(second).toBe(first);
    expect(first).not.toContain("$HOME");
  });
});
