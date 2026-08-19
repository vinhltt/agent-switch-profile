import { CommanderError } from "commander";
import pc from "picocolors";

import { CliError, EXIT_RUNTIME, EXIT_USAGE } from "./commands/shared";
import { buildProgram } from "./program";
import { ValidationError } from "./validate";

/**
 * One place decides how a failure leaves the process:
 *   0  success, including --help and --version
 *   1  the command ran but could not finish
 *   2  the invocation was wrong
 */
function exitCodeFor(error: unknown): number {
  // Commander uses exceptions for --help and --version too; those are not errors.
  if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : EXIT_USAGE;
  if (error instanceof ValidationError) return EXIT_USAGE;
  if (error instanceof CliError) return error.exitCode;
  return EXIT_RUNTIME;
}

async function main(): Promise<void> {
  const program = buildProgram();
  // Commander exits 1 on a parse error by default; route it through our own map.
  // Each subcommand parses its own argv, so each needs the override of its own.
  program.exitOverride();
  for (const subcommand of program.commands) subcommand.exitOverride();

  try {
    await program.parseAsync();
  } catch (error) {
    const code = exitCodeFor(error);
    if (code !== 0) {
      const message = error instanceof Error ? error.message : String(error);
      // Commander has already printed its own message.
      if (!(error instanceof CommanderError)) {
        process.stderr.write(`${pc.red("error:")} ${message}\n`);
      }
    }
    process.exit(code);
  }
}

await main();
