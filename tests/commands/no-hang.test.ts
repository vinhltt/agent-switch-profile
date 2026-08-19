import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Regression for a hang that shipped once already: the interactive check looked
 * at `stdout.isTTY` while the prompt read `stdin`, so a command run with stdin
 * closed sat waiting for input that could never arrive.
 *
 * These spawn the built artifact under plain Node — the same thing users run.
 */

const projectRoot = path.resolve(import.meta.dir, "..", "..");
const cliPath = path.join(projectRoot, "dist", "cli.js");

let home: string;

beforeAll(() => {
  if (!fs.existsSync(cliPath)) {
    const build = spawnSync("bun", ["run", "build"], { cwd: projectRoot, encoding: "utf8" });
    if (build.status !== 0) throw new Error(`build failed: ${build.stderr}`);
  }
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "asp-hang-")));
  fs.writeFileSync(path.join(home, ".bashrc"), "# rc\n");
});

function runWithClosedStdin(...args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("node", [cliPath, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, SHELL: "/bin/bash" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    encoding: "utf8",
  });
}

describe("with stdin closed", () => {
  test("create finishes without waiting for a prompt", () => {
    const result = runWithClosedStdin("--harness", "claude", "create", "work");

    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ccwork");
  });

  test("list finishes", () => {
    const result = runWithClosedStdin("--harness", "claude", "list");
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  });

  test("delete refuses instead of blocking on the confirmation", () => {
    const result = runWithClosedStdin("--harness", "claude", "delete", "work");

    expect(result.signal).toBeNull();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--force");
  });

  test("delete --force finishes", () => {
    const result = runWithClosedStdin("--harness", "claude", "delete", "work", "--force");
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  });

  test("--json writes JSON and nothing else to stdout", () => {
    const result = runWithClosedStdin("--harness", "claude", "list", "--json");

    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout as string)).not.toThrow();
    expect(JSON.parse(result.stdout as string).schemaVersion).toBe(1);
  });
});
