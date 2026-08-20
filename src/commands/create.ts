import { isCancel, text } from "@clack/prompts";
import type { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import pc from "picocolors";

import type { HarnessAdapter } from "../harness/types";
import { profileDir } from "../paths";
import {
  type CreateProfileResult,
  type ProfileMeta,
  type ProfileMetaResult,
  createProfile as createProfileOnDisk,
  readProfileMeta,
} from "../profile-store";
import {
  type AliasEntry,
  type HostPaths,
  type RcWriteResult,
  captureRcPreImage,
  findCollision,
  hasAlias,
  hostPathsFor,
  readBlock,
  restoreRcPreImage,
  upsertAlias as upsertAliasInRc,
} from "../shell/rc-block";
import { ValidationError, validateAliasName, validateProfileName } from "../validate";

import {
  EXIT_OK,
  type GlobalOptions,
  binaryOnPath,
  installCursorGuard,
  isInteractive,
  resolveHarness,
  resolveRcPath,
} from "./shared";

// ---------------------------------------------------------------------------
// Decision, with no I/O of its own
// ---------------------------------------------------------------------------

export interface CreateObservation {
  dirExists: boolean;
  meta: ProfileMetaResult;
  /** Block entry that already uses this alias name, whatever it points at. */
  entryForAlias: AliasEntry | undefined;
  /** An `alias <name>=` the user wrote outside the managed block. */
  collisionOutsideBlock: string | null;
}

export type CreateAction =
  | { kind: "create"; alias: string }
  /** A previous run died partway through; finish it instead of refusing. */
  | { kind: "resume"; alias: string; note: string }
  | { kind: "up-to-date"; alias: string };

export interface CreatePlanInput {
  name: string;
  requestedAlias: string | undefined;
  defaultAlias: string;
  profileDir: string;
  state: CreateObservation;
}

export function planCreate(input: CreatePlanInput): CreateAction {
  const { state } = input;

  if (state.dirExists && state.meta.status === "invalid") {
    throw new ValidationError(
      `${input.profileDir} exists but its profile.json is unusable (${state.meta.reason}). ` +
        `Delete the profile and create it again.`,
    );
  }

  const recorded = state.meta.status === "ok" ? state.meta.meta : undefined;

  if (input.requestedAlias && recorded && recorded.alias !== input.requestedAlias) {
    throw new ValidationError(
      `profile ${JSON.stringify(input.name)} already uses alias ${JSON.stringify(recorded.alias)}. ` +
        `Delete it first if you want ${JSON.stringify(input.requestedAlias)} instead.`,
    );
  }

  const alias = validateAliasName(input.requestedAlias ?? recorded?.alias ?? input.defaultAlias);

  if (state.collisionOutsideBlock) {
    throw new ValidationError(
      `${JSON.stringify(alias)} is already defined outside the asp block in your rc file:\n` +
        `  ${state.collisionOutsideBlock}\n` +
        `Pick another alias with --alias, or remove that line yourself.`,
    );
  }

  if (state.entryForAlias && state.entryForAlias.profileDir !== input.profileDir) {
    throw new ValidationError(
      `alias ${JSON.stringify(alias)} already points at ${state.entryForAlias.profileDir}. ` +
        `Pick another alias with --alias.`,
    );
  }

  if (!state.dirExists) return { kind: "create", alias };

  if (state.entryForAlias && recorded) return { kind: "up-to-date", alias };

  return {
    kind: "resume",
    alias,
    note: state.entryForAlias
      ? "profile directory existed but its metadata was missing"
      : "profile directory existed but its alias was not in the rc file",
  };
}

export function observeCreate(
  adapter: HarnessAdapter,
  name: string,
  alias: string,
  dir: string,
  rcPath: string,
  host: HostPaths,
): CreateObservation {
  const block = readBlock(rcPath, host);
  let content = "";
  try {
    content = fs.readFileSync(rcPath, "utf8");
  } catch {
    // No rc file yet: nothing outside the block to collide with.
  }

  return {
    dirExists: fs.existsSync(dir),
    meta: readProfileMeta(dir),
    entryForAlias: block.entries.find((entry) => entry.alias === alias),
    collisionOutsideBlock: findCollision(content, alias),
  };
}

// ---------------------------------------------------------------------------
// Execution, with a symmetric rollback
// ---------------------------------------------------------------------------

export interface CreateEffects {
  createProfile: typeof createProfileOnDisk;
  upsertAlias: typeof upsertAliasInRc;
  /** Post-write proof that the alias really landed in the rc file. */
  verifyAlias: (rcPath: string, host: HostPaths, alias: string) => void;
}

export const defaultCreateEffects: CreateEffects = {
  createProfile: createProfileOnDisk,
  upsertAlias: upsertAliasInRc,
  verifyAlias: (rcPath, host, alias) => {
    if (!hasAlias(readBlock(rcPath, host), alias)) {
      throw new Error(`alias ${alias} is missing from ${rcPath} after writing it`);
    }
  },
};

export interface ExecuteCreateInput {
  adapter: HarnessAdapter;
  name: string;
  alias: string;
  dir: string;
  rcPath: string;
  host: HostPaths;
}

export interface CreateOutcome {
  dir: string;
  alias: string;
  rcPath: string;
  meta: ProfileMeta | null;
  rcWrite: RcWriteResult;
  resumed: boolean;
}

export function executeCreate(
  input: ExecuteCreateInput,
  effects: CreateEffects = defaultCreateEffects,
): CreateOutcome {
  const preImage = captureRcPreImage(input.rcPath);
  let createdDir: string | null = null;
  let rcTouched = false;

  try {
    const created: CreateProfileResult = effects.createProfile(
      input.adapter,
      input.name,
      input.alias,
      input.rcPath,
    );
    if (created.status === "created") createdDir = created.dir;

    const entry: AliasEntry = {
      alias: input.alias,
      profileDir: input.dir,
      envVar: input.adapter.configEnvVar,
      binary: input.adapter.binary,
    };

    rcTouched = true;
    const rcWrite = effects.upsertAlias(input.rcPath, input.host, entry);
    effects.verifyAlias(input.rcPath, input.host, input.alias);

    return {
      dir: input.dir,
      alias: input.alias,
      rcPath: input.rcPath,
      meta: created.status === "created" ? created.meta : null,
      rcWrite,
      resumed: created.status === "exists",
    };
  } catch (error) {
    if (createdDir === null && !rcTouched) throw error;
    throw rollback(error as Error, preImage, createdDir);
  }
}

/** Undo in the reverse order of the damage: rc file first, then the directory. */
function rollback(
  cause: Error,
  preImage: ReturnType<typeof captureRcPreImage>,
  createdDir: string | null,
): Error {
  const failures: string[] = [];

  try {
    restoreRcPreImage(preImage);
  } catch (error) {
    failures.push(`could not restore ${preImage.realPath}: ${(error as Error).message}`);
  }

  if (createdDir) {
    try {
      fs.rmSync(createdDir, { recursive: true, force: true });
    } catch (error) {
      failures.push(`could not remove ${createdDir}: ${(error as Error).message}`);
    }
  }

  if (failures.length === 0) return cause;

  return new Error(
    `${cause.message}\n\nRolling back failed as well — clean these up by hand:\n` +
      failures.map((line) => `  - ${line}`).join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

async function promptAlias(defaultAlias: string): Promise<string> {
  const answer = await text({
    message: "Alias to launch this profile with",
    placeholder: defaultAlias,
    defaultValue: defaultAlias,
    validate: (value) => {
      if (!value) return undefined;
      try {
        validateAliasName(value);
        return undefined;
      } catch (error) {
        return (error as Error).message;
      }
    },
  });

  if (isCancel(answer)) {
    process.stderr.write(pc.dim("cancelled\n"));
    process.exit(EXIT_OK);
  }
  return (answer as string) || defaultAlias;
}

interface CreateOptions {
  alias?: string;
  rc?: string;
}

export function register(program: Command): void {
  program
    .command("create")
    .description("create a profile and the shell alias that selects it")
    .argument("<name>", "profile name, kebab-case")
    .option("--alias <alias>", "shell alias to generate instead of the default")
    .option("--rc <path>", "shell rc file to write the managed block into")
    .action(async (name: string, options: CreateOptions, command: Command) => {
      const adapter = resolveHarness(command.optsWithGlobals<GlobalOptions>());
      const validName = validateProfileName(name);
      const homeDir = os.homedir();
      const host = hostPathsFor(homeDir, process.platform);
      const dir = profileDir(adapter.name, validName);

      const existing = readProfileMeta(dir);
      const recorded = existing.status === "ok" ? existing.meta : undefined;
      const rc = resolveRcPath(options.rc, recorded?.rcFile, homeDir, process.env.SHELL);

      const defaultAlias = `${adapter.aliasPrefix}${validName}`;
      let requestedAlias = options.alias;
      if (!requestedAlias && !recorded && isInteractive()) {
        installCursorGuard();
        requestedAlias = await promptAlias(defaultAlias);
      }

      const provisionalAlias = requestedAlias ?? recorded?.alias ?? defaultAlias;
      const state = observeCreate(adapter, validName, provisionalAlias, dir, rc.rcPath, host);
      const action = planCreate({
        name: validName,
        requestedAlias,
        defaultAlias,
        profileDir: dir,
        state,
      });

      if (action.kind === "up-to-date") {
        process.stdout.write(
          `${pc.green("✓")} profile ${pc.bold(validName)} already set up as ${pc.bold(action.alias)}\n`,
        );
        return;
      }

      const outcome = executeCreate({
        adapter,
        name: validName,
        alias: action.alias,
        dir,
        rcPath: rc.rcPath,
        host,
      });

      for (const warning of outcome.rcWrite.warnings) {
        process.stderr.write(`${pc.yellow("!")} ${warning}\n`);
      }

      if (!binaryOnPath(adapter.binary, process.platform, process.env)) {
        process.stderr.write(
          `${pc.yellow("!")} ${adapter.binary} was not found on PATH — the alias below will fail until it is installed and on PATH\n`,
        );
      }

      const heading =
        action.kind === "resume"
          ? `${pc.yellow("✓")} resumed ${pc.bold(validName)} (${action.note})`
          : `${pc.green("✓")} created ${pc.bold(validName)}`;

      process.stdout.write(
        [
          heading,
          `  profile dir  ${outcome.dir}`,
          `  alias        ${pc.bold(outcome.alias)}`,
          `  rc file      ${outcome.rcPath}`,
          ...(outcome.rcWrite.backupPath ? [`  rc backup    ${outcome.rcWrite.backupPath}`] : []),
          "",
          "Next:",
          `  1. open a new terminal, or run: source ${outcome.rcPath}`,
          `  2. run: ${pc.bold(outcome.alias)}`,
          `  3. ${adapter.authHint}`,
          "",
        ].join("\n"),
      );
    });
}
