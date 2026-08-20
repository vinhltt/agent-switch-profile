import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  RC_BASENAME_ALLOWLIST,
  assertGitBashOnWindows,
  detectRcFile,
  validateRcPath,
} from "../../src/shell/rc-path";
import { ValidationError } from "../../src/validate";

import { createTempHome, type TempHome } from "../helpers/temp-home";

let tmp: TempHome;

beforeEach(() => {
  tmp = createTempHome();
});
afterEach(() => {
  tmp.cleanup();
});

describe("validateRcPath", () => {
  test.each([...RC_BASENAME_ALLOWLIST])("accepts an existing %s", (basename: string) => {
    const target = path.join(tmp.home, basename);
    fs.writeFileSync(target, "");
    expect(validateRcPath(target, tmp.home)).toBe(target);
  });

  test("accepts an rc file that does not exist yet", () => {
    const target = path.join(tmp.home, ".zshrc");
    expect(validateRcPath(target, tmp.home)).toBe(target);
    expect(fs.existsSync(target)).toBe(false);
  });

  test("refuses a basename outside the allowlist", () => {
    const target = path.join(tmp.home, ".ssh-config");
    fs.writeFileSync(target, "");
    expect(() => validateRcPath(target, tmp.home)).toThrow(ValidationError);
  });

  test("refuses an allowlisted name outside the home directory", () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asp-out-")));
    const target = path.join(outside, ".bashrc");
    fs.writeFileSync(target, "");
    try {
      expect(() => validateRcPath(target, tmp.home)).toThrow(/must live under/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("refuses traversal that lands outside home", () => {
    expect(() => validateRcPath(path.join(tmp.home, "..", ".bashrc"), tmp.home)).toThrow(
      ValidationError,
    );
  });

  test("refuses a directory wearing an rc name", () => {
    const target = path.join(tmp.home, ".profile");
    fs.mkdirSync(target);
    expect(() => validateRcPath(target, tmp.home)).toThrow(/not a regular file/);
  });

  test("follows a symlink that stays inside home", () => {
    const real = path.join(tmp.home, "dotfiles-bashrc");
    fs.writeFileSync(real, "# managed elsewhere\n");
    const link = path.join(tmp.home, ".zshrc");
    fs.symlinkSync(real, link);

    expect(validateRcPath(link, tmp.home)).toBe(link);
  });

  test("refuses a symlink escaping home", () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asp-out-")));
    const real = path.join(outside, "bashrc");
    fs.writeFileSync(real, "");
    const link = path.join(tmp.home, ".zshrc");
    fs.symlinkSync(real, link);

    try {
      expect(() => validateRcPath(link, tmp.home)).toThrow(/pointing outside/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("refuses a broken symlink", () => {
    const link = path.join(tmp.home, ".zshrc");
    fs.symlinkSync(path.join(tmp.home, "gone"), link);
    expect(() => validateRcPath(link, tmp.home)).toThrow(/broken symlink/);
  });

  test("refuses empty and non-string input", () => {
    expect(() => validateRcPath("", tmp.home)).toThrow(ValidationError);
    expect(() => validateRcPath(null, tmp.home)).toThrow(ValidationError);
  });
});

describe("assertGitBashOnWindows", () => {
  test("passes through on non-win32 regardless of MSYSTEM", () => {
    expect(() => assertGitBashOnWindows("linux", {})).not.toThrow();
    expect(() => assertGitBashOnWindows("darwin", {})).not.toThrow();
  });

  test("passes through on win32 when MSYSTEM is set (Git Bash)", () => {
    expect(() => assertGitBashOnWindows("win32", { MSYSTEM: "MINGW64" })).not.toThrow();
  });

  test("refuses win32 without MSYSTEM (PowerShell or CMD)", () => {
    expect(() => assertGitBashOnWindows("win32", {})).toThrow(/Git Bash/);
  });

  // The bug this guards against: a configured defaultRcFile or a recorded
  // profile rcFile lets resolveRcPath skip detectRcFile (and its own $SHELL
  // check) entirely — this guard must not depend on that path being taken.
  test("refuses win32 even with $SHELL set (inherited from a parent Git Bash process)", () => {
    expect(() =>
      assertGitBashOnWindows("win32", { SHELL: "/usr/bin/bash" }),
    ).toThrow(/Git Bash/);
  });
});

describe("detectRcFile", () => {
  test("maps a posix bash shell to .bashrc", () => {
    expect(detectRcFile("/usr/bin/bash", tmp.home, "linux")).toBe(path.join(tmp.home, ".bashrc"));
  });

  test("maps a posix zsh shell to .zshrc", () => {
    expect(detectRcFile("/usr/bin/zsh", tmp.home, "linux")).toBe(path.join(tmp.home, ".zshrc"));
  });

  test("maps a Git Bash Windows-native bash.exe path to .bashrc", () => {
    // MSYS/Git Bash rewrites $SHELL to a full Windows path when spawning a
    // Win32-native process (e.g. node.exe), so the value never looks like
    // "/usr/bin/bash" on Windows.
    expect(detectRcFile("C:\\Program Files\\Git\\usr\\bin\\bash.exe", tmp.home, "win32")).toBe(
      path.join(tmp.home, ".bashrc"),
    );
  });

  test("maps a Windows-native zsh.exe path to .zshrc", () => {
    expect(detectRcFile("C:\\tools\\zsh.exe", tmp.home, "win32")).toBe(
      path.join(tmp.home, ".zshrc"),
    );
  });

  // path.win32.parse().name would strip ".real" as if it were an extension,
  // silently accepting a shell the old path.basename-based check rejected —
  // Goal 4 requires zero behavior change on posix.
  test("still refuses a posix shell whose name merely contains a dot", () => {
    expect(() => detectRcFile("/usr/bin/bash.real", tmp.home, "linux")).toThrow(
      /unsupported shell/,
    );
  });

  test("refuses an unset shell", () => {
    expect(() => detectRcFile(undefined, tmp.home, "linux")).toThrow(ValidationError);
  });

  test("refuses an unset shell on win32 with a message pointing at Git Bash and WSL", () => {
    expect(() => detectRcFile(undefined, tmp.home, "win32")).toThrow(/Git Bash/);
    expect(() => detectRcFile(undefined, tmp.home, "win32")).toThrow(/WSL/);
  });

  test("refuses an unsupported shell", () => {
    expect(() => detectRcFile("/usr/bin/fish", tmp.home, "linux")).toThrow(/unsupported shell/);
  });
});
