import { Command } from "commander";

import pkg from "../package.json" with { type: "json" };

import { register as registerCreate } from "./commands/create";
import { register as registerDelete } from "./commands/delete";
import { register as registerList } from "./commands/list";
import { assertGitBashOnWindows } from "./shell/rc-path";

/**
 * Build the CLI without running it, so tests can inspect the wiring and the
 * entry point stays a single `parseAsync()` call.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("asp")
    .description(pkg.description)
    .version(pkg.version)
    .option("--harness <name>", "target agent harness (phase 0: claude)")
    // Runs before every subcommand's own action, so a configured
    // `defaultRcFile` or a profile's recorded rc path can never let a
    // PowerShell/CMD invocation skip this — unlike relying on $SHELL
    // detection alone, which only runs when a command actually needs to
    // resolve an rc path.
    .hook("preAction", () => assertGitBashOnWindows(process.platform, process.env));

  registerCreate(program);
  registerList(program);
  registerDelete(program);

  return program;
}
