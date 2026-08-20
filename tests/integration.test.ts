import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The whole lifecycle against the artifact that actually ships: `dist/cli.js`
 * under plain Node, in a throwaway HOME. Nothing here imports the source, so a
 * bundle that only works under Bun fails these tests.
 */

const projectRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(projectRoot, "dist", "cli.js");

const RC_PROLOGUE = '# my shell config\nexport PATH="$PATH:/opt/bin"\nalias ll="ls -la"\n';

let home: string;
let rcPath: string;
/** A stub `claude` on PATH, since the sandbox running these tests has no real one. */
let binDir: string;

beforeAll(() => {
  const build = spawnSync("bun", ["run", "build"], { cwd: projectRoot, encoding: "utf8" });
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr}`);

  binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asp-integration-bin-")));
  const stub = path.join(binDir, "claude");
  fs.writeFileSync(stub, "#!/usr/bin/env bash\n");
  fs.chmodSync(stub, 0o755);
});

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asp-integration-")));
  rcPath = path.join(home, ".bashrc");
  fs.writeFileSync(rcPath, RC_PROLOGUE);
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
}

function asp(...args: string[]): Run {
  const result = spawnSync("node", [cliPath, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      SHELL: "/bin/bash",
      CLAUDE_CONFIG_DIR: undefined,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    // stdin closed on purpose: nothing may wait for input it cannot get.
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    signal: result.signal,
  };
}

function rc(): string {
  return fs.readFileSync(rcPath, "utf8");
}

function aliasLines(): string[] {
  return rc()
    .split("\n")
    .filter((line) => line.startsWith("alias cc"));
}

function profilePath(name: string, ...rest: string[]): string {
  return path.join(home, ".agent-switch-profiles", "claude", name, ...rest);
}

describe("full lifecycle", () => {
  test("create, create again, list, delete, list", () => {
    // --- create the first profile ------------------------------------------
    const created = asp("--harness", "claude", "create", "work", "--alias", "ccwork");

    expect(created.signal).toBeNull();
    expect(created.status).toBe(0);
    expect(created.stdout).toContain("ccwork");

    expect(fs.existsSync(profilePath("work"))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(profilePath("work", "profile.json"), "utf8"));
    expect(meta).toMatchObject({ harness: "claude", name: "work", alias: "ccwork", rcFile: rcPath });

    expect(rc().startsWith(RC_PROLOGUE)).toBe(true);
    expect(rc()).toContain("# >>> asp managed block v1 >>>");
    expect(rc()).toContain(
      `alias ccwork='CLAUDE_CONFIG_DIR="$HOME/.agent-switch-profiles/claude/work" claude'`,
    );

    // --- a second profile shares the one block -----------------------------
    expect(asp("--harness", "claude", "create", "personal").status).toBe(0);

    expect(rc().match(/asp managed block/g)).toHaveLength(2);
    expect(aliasLines()).toEqual([
      `alias ccpersonal='CLAUDE_CONFIG_DIR="$HOME/.agent-switch-profiles/claude/personal" claude'`,
      `alias ccwork='CLAUDE_CONFIG_DIR="$HOME/.agent-switch-profiles/claude/work" claude'`,
    ]);

    // --- list --json is a stable machine contract --------------------------
    const listed = asp("--harness", "claude", "list", "--json");
    expect(listed.status).toBe(0);

    const json = JSON.parse(listed.stdout);
    expect(json.schemaVersion).toBe(1);
    expect(json.harness).toBe("claude");
    expect(json.warnings).toEqual([]);
    expect(json.profiles.map((profile: { name: string }) => profile.name)).toEqual([
      "personal",
      "work",
    ]);

    for (const profile of json.profiles) {
      expect(typeof profile.name).toBe("string");
      expect(typeof profile.alias).toBe("string");
      expect(path.isAbsolute(profile.dir)).toBe(true);
      expect(["authenticated", "unauthenticated", "unknown", "invalid"]).toContain(
        profile.authStatus,
      );
      expect(profile.aliasInRc).toBe(true);
      expect(Number.isNaN(Date.parse(profile.createdAt))).toBe(false);
    }

    // --- delete one, keep the other ----------------------------------------
    const deleted = asp("--harness", "claude", "delete", "work", "--force");
    expect(deleted.status).toBe(0);

    expect(fs.existsSync(profilePath("work"))).toBe(false);
    expect(fs.existsSync(profilePath("personal"))).toBe(true);
    expect(aliasLines()).toHaveLength(1);
    expect(rc().startsWith(RC_PROLOGUE)).toBe(true);

    // --- delete the last one: the file returns to exactly what it was -------
    expect(asp("--harness", "claude", "delete", "personal", "--force").status).toBe(0);
    expect(rc()).toBe(RC_PROLOGUE);

    const final = JSON.parse(asp("--harness", "claude", "list", "--json").stdout);
    expect(final.profiles).toEqual([]);
  });
});

describe("the shipped artifact", () => {
  test("starts under plain Node and reports its version", () => {
    const version = asp("--version");
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("begins with a shebang so npm can link it as a bin", () => {
    expect(fs.readFileSync(cliPath, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  test("carries no Bun-only runtime imports", () => {
    expect(fs.readFileSync(cliPath, "utf8")).not.toMatch(/from\s*["']bun[:"']/);
  });
});

describe("exit codes", () => {
  test.each([
    [["--harness", "claude", "create", "work", "--bogus"], 2, "unknown option"],
    [["--harness", "claude", "nosuchcommand"], 2, "unknown command"],
    [["--harness", "claude", "create"], 2, "missing required argument"],
    [["--harness", "codex", "list"], 2, "unknown harness"],
    [["--harness", "claude", "create", "x", "--alias", "bad;alias"], 2, "invalid alias"],
  ])("%p exits %i", (args, code, fragment) => {
    const result = asp(...(args as string[]));
    expect(result.status).toBe(code as number);
    expect(result.stderr).toContain(fragment as string);
  });

  for (const args of [["--help"], ["--version"], ["create", "--help"]]) {
    test(`${args.join(" ")} exits 0`, () => {
      expect(asp(...args).status).toBe(0);
    });
  }

  test("nothing is created when validation fails", () => {
    asp("--harness", "claude", "create", "x", "--alias", "bad;alias");
    expect(fs.existsSync(path.join(home, ".agent-switch-profiles"))).toBe(false);
    expect(rc()).toBe(RC_PROLOGUE);
  });
});

describe("with stdin closed", () => {
  test("delete refuses rather than waiting for a confirmation", () => {
    asp("--harness", "claude", "create", "work", "--alias", "ccwork");

    const result = asp("--harness", "claude", "delete", "work");

    expect(result.signal).toBeNull();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--force");
    expect(fs.existsSync(profilePath("work"))).toBe(true);
  });

  test("create takes the default alias instead of prompting", () => {
    const result = asp("--harness", "claude", "create", "solo");

    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(rc()).toContain("alias ccsolo=");
  });
});

describe("recovery paths", () => {
  test("a second create finishes an interrupted one", () => {
    asp("--harness", "claude", "create", "work", "--alias", "ccwork");
    fs.writeFileSync(rcPath, RC_PROLOGUE); // as if the rc write never happened

    const resumed = asp("--harness", "claude", "create", "work");

    expect(resumed.status).toBe(0);
    expect(resumed.stdout).toContain("resumed");
    expect(rc()).toContain("alias ccwork=");
  });

  test("list flags a profile whose alias never landed", () => {
    fs.mkdirSync(profilePath("ghost"), { recursive: true });

    const json = JSON.parse(asp("--harness", "claude", "list", "--json").stdout);

    expect(json.profiles[0].aliasInRc).toBe(false);
    expect(json.warnings.map((warning: { code: string }) => warning.code)).toContain(
      "MISSING_ALIAS",
    );
  });

  test("delete clears an alias left behind by a deleted directory", () => {
    asp("--harness", "claude", "create", "work", "--alias", "ccwork");
    fs.rmSync(profilePath("work"), { recursive: true, force: true });

    const result = asp("--harness", "claude", "delete", "work", "--force");

    expect(result.status).toBe(0);
    expect(rc()).toBe(RC_PROLOGUE);
  });

  test("an rc file damaged by hand is refused, not rewritten", () => {
    const damaged = `${RC_PROLOGUE}# >>> asp managed block v1 >>>\nalias ccx='y'\n`;
    fs.writeFileSync(rcPath, damaged);

    const result = asp("--harness", "claude", "create", "work", "--alias", "ccwork");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/damaged/);
    expect(rc()).toBe(damaged);
  });
});
