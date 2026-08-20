import { confirm, isCancel } from "@clack/prompts";
import type { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import pc from "picocolors";

import type { HarnessAdapter } from "../harness/types";
import { profileDir } from "../paths";
import { type DeleteProfileResult, deleteProfile as deleteProfileOnDisk, readProfileMeta } from "../profile-store";
import {
  type HostPaths,
  type RcWriteResult,
  hostPathsFor,
  readBlock,
  removeAlias as removeAliasFromRc,
} from "../shell/rc-block";
import { ValidationError, validateProfileName } from "../validate";

import {
  CliError,
  EXIT_OK,
  EXIT_USAGE,
  type GlobalOptions,
  countRunningHarnessProcesses,
  findProcessesUsingProfile,
  installCursorGuard,
  isInteractive,
  resolveHarness,
  resolveRcPath,
} from "./shared";

export interface DeleteObservation {
  dirExists: boolean;
  /** Alias recorded in metadata or found pointing at this directory. */
  alias: string | null;
  /** PIDs still running with this profile's config dir. */
  liveProcesses: number[];
}

export type DeleteAction =
  | { kind: "delete"; alias: string | null }
  /** Directory already gone; only the leftover alias needs clearing. */
  | { kind: "clear-orphan-alias"; alias: string }
  | { kind: "nothing-to-do" };

export interface DeletePlanInput {
  name: string;
  force: boolean;
  interactive: boolean;
  state: DeleteObservation;
}

export function planDelete(input: DeletePlanInput): DeleteAction {
  const { state } = input;

  if (state.liveProcesses.length > 0 && !input.force) {
    throw new CliError(
      `${input.name} is in use by ${state.liveProcesses.length} running process(es) ` +
        `(pid ${state.liveProcesses.join(", ")}). Quit them first, or pass --force.`,
    );
  }

  if (!state.dirExists) {
    return state.alias ? { kind: "clear-orphan-alias", alias: state.alias } : { kind: "nothing-to-do" };
  }

  // Never block waiting for input that cannot arrive.
  if (!input.force && !input.interactive) {
    throw new ValidationError(
      `refusing to delete ${input.name} without a confirmation. Re-run with --force in a ` +
        `non-interactive shell.`,
    );
  }

  return { kind: "delete", alias: state.alias };
}

export function observeDelete(
  adapter: HarnessAdapter,
  dir: string,
  rcPath: string,
  host: HostPaths,
): DeleteObservation {
  const meta = readProfileMeta(dir);
  const entry = readBlock(rcPath, host).entries.find((candidate) => candidate.profileDir === dir);

  return {
    dirExists: fs.existsSync(dir),
    alias: entry?.alias ?? (meta.status === "ok" ? meta.meta.alias : null),
    liveProcesses: findProcessesUsingProfile(adapter.configEnvVar, dir),
  };
}

export interface DeleteEffects {
  deleteProfile: typeof deleteProfileOnDisk;
  removeAlias: typeof removeAliasFromRc;
}

export const defaultDeleteEffects: DeleteEffects = {
  deleteProfile: deleteProfileOnDisk,
  removeAlias: removeAliasFromRc,
};

export interface DeleteOutcome {
  dir: string;
  removed: DeleteProfileResult | null;
  aliasRemoved: string | null;
  rcWrite: RcWriteResult | null;
}

/**
 * Directory first. Removing the credentials is the point of the command; the
 * alias is only a convenience. If the removal fails the alias stays exactly
 * where it is, so the profile is never silently unreachable but still on disk.
 */
export function executeDelete(
  adapter: HarnessAdapter,
  name: string,
  action: DeleteAction,
  rcPath: string,
  host: HostPaths,
  effects: DeleteEffects = defaultDeleteEffects,
): DeleteOutcome {
  const dir = profileDir(adapter.name, name);

  if (action.kind === "nothing-to-do") {
    return { dir, removed: null, aliasRemoved: null, rcWrite: null };
  }

  if (action.kind === "clear-orphan-alias") {
    return {
      dir,
      removed: null,
      aliasRemoved: action.alias,
      rcWrite: effects.removeAlias(rcPath, host, action.alias),
    };
  }

  const removed = effects.deleteProfile(adapter, name);

  if (!action.alias) return { dir, removed, aliasRemoved: null, rcWrite: null };

  return {
    dir,
    removed,
    aliasRemoved: action.alias,
    rcWrite: effects.removeAlias(rcPath, host, action.alias),
  };
}

/**
 * A forced delete removes the directory, but a harness process that outlives the
 * command writes its config back when it exits, and the directory reappears
 * looking like a half-finished create. Say so at the time rather than leaving it
 * to be discovered later.
 */
export function recreationNotice(name: string, pids: readonly number[]): string | null {
  if (pids.length === 0) return null;
  return (
    `${name} was deleted while pid ${pids.join(", ")} still had it open. That process may write ` +
    `its config directory back when it exits — quit it, then run delete again to be sure.`
  );
}

async function confirmDeletion(name: string, dir: string, alias: string | null): Promise<boolean> {
  const answer = await confirm({
    message:
      `Delete profile ${name}? This removes ${dir} and its saved login. ` +
      `${alias ? `Alias ${alias} will be removed too. ` : ""}This cannot be undone.`,
    initialValue: false,
  });

  if (isCancel(answer)) return false;
  return answer === true;
}

interface DeleteOptions {
  force?: boolean;
  rc?: string;
}

export function register(program: Command): void {
  program
    .command("delete")
    .description("delete a profile directory and remove its alias")
    .argument("<name>", "profile name")
    .option("--force", "skip the confirmation prompt")
    .option("--rc <path>", "shell rc file holding the managed block")
    .action(async (name: string, options: DeleteOptions, command: Command) => {
      const adapter = resolveHarness(command.optsWithGlobals<GlobalOptions>());
      const validName = validateProfileName(name);
      const homeDir = os.homedir();
      const host = hostPathsFor(homeDir, process.platform);
      const dir = profileDir(adapter.name, validName);

      const meta = readProfileMeta(dir);
      const recorded = meta.status === "ok" ? meta.meta : undefined;
      const rc = resolveRcPath(options.rc, recorded?.rcFile, homeDir, process.env.SHELL);

      const interactive = isInteractive();
      const state = observeDelete(adapter, dir, rc.rcPath, host);
      const action = planDelete({
        name: validName,
        force: Boolean(options.force),
        interactive,
        state,
      });

      if (action.kind === "nothing-to-do") {
        process.stderr.write(`${pc.yellow("!")} no profile named ${validName}, and no alias to clear\n`);
        process.exitCode = EXIT_USAGE;
        return;
      }

      if (state.liveProcesses.length > 0) {
        process.stderr.write(
          `${pc.yellow("!")} ${validName} is still in use by pid ${state.liveProcesses.join(", ")} — ` +
            `deleting anyway because --force was given\n`,
        );
      } else {
        const runningCount = countRunningHarnessProcesses(adapter.binary, process.platform);
        if (runningCount === null) {
          if (process.platform !== "linux") {
            process.stderr.write(
              `${pc.dim("note: asp cannot check for running sessions on this platform")}\n`,
            );
          }
        } else if (runningCount > 0) {
          process.stderr.write(
            `${pc.yellow("!")} ${runningCount} ${adapter.binary} process(es) are running — asp cannot ` +
              `tell which profile they belong to on this platform. Deleting anyway.\n`,
          );
        }
      }

      if (action.kind === "delete" && !options.force) {
        installCursorGuard();
        if (!(await confirmDeletion(validName, dir, action.alias))) {
          process.stderr.write(pc.dim("cancelled\n"));
          process.exitCode = EXIT_OK;
          return;
        }
      }

      const outcome = executeDelete(adapter, validName, action, rc.rcPath, host);

      for (const warning of outcome.rcWrite?.warnings ?? []) {
        process.stderr.write(`${pc.yellow("!")} ${warning}\n`);
      }

      const notice = outcome.removed?.existed
        ? recreationNotice(validName, state.liveProcesses)
        : null;
      if (notice) process.stderr.write(`${pc.yellow("!")} ${notice}\n`);

      const lines: string[] = [];
      if (outcome.removed?.existed) lines.push(`  removed dir  ${outcome.dir}`);
      if (outcome.aliasRemoved) lines.push(`  removed alias ${outcome.aliasRemoved}`);
      if (outcome.rcWrite?.backupPath) lines.push(`  rc backup    ${outcome.rcWrite.backupPath}`);

      process.stdout.write(
        [
          action.kind === "clear-orphan-alias"
            ? `${pc.green("✓")} cleared orphan alias for ${pc.bold(validName)}`
            : `${pc.green("✓")} deleted ${pc.bold(validName)}`,
          ...lines,
          "",
        ].join("\n"),
      );
    });
}
