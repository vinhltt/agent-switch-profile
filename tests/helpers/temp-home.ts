import { spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { STORE_DIR_NAME } from "../../src/paths";
import { type HostPaths, hostPathsFor } from "../../src/shell/rc-block";

export interface TempHome {
  home: string;
  /** `hostPathsFor(home, "linux")` — the posix host most tests exercise. */
  host: HostPaths;
  store: string;
  /** A pre-created `.bashrc`, since rc paths must pass the allowlist. */
  rcFile: string;
  cleanup(): void;
}

/**
 * Point the whole store at a throwaway directory.
 *
 * Bun resolves `os.homedir()` from the environment it was spawned with, so
 * assigning `process.env.HOME` mid-run does not move it — the spy is what keeps
 * these tests off the real home directory. HOME is set as well for any code that
 * reads the variable directly.
 */
export function createTempHome(): TempHome {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asp-test-")));
  const rcFile = path.join(home, ".bashrc");
  fs.writeFileSync(rcFile, "# pre-existing rc content\n");

  const spy = spyOn(os, "homedir").mockReturnValue(home);
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  return {
    home,
    host: hostPathsFor(home, "linux"),
    store: path.join(home, STORE_DIR_NAME),
    rcFile,
    cleanup(): void {
      spy.mockRestore();
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Permission bits, e.g. 0o700. */
export function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777;
}
