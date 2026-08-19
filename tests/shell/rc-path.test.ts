import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RC_BASENAME_ALLOWLIST, validateRcPath } from "../../src/shell/rc-path";
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
