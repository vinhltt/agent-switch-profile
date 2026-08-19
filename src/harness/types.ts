/**
 * Everything asp needs to know about one agent CLI. Phase 0 ships a single
 * adapter; the shape exists so adding codex/gemini later is data, not branching.
 */
export interface HarnessAdapter {
  /** Identifier used on the command line and as the store subdirectory name. */
  readonly name: string;
  /** Executable the generated alias invokes. */
  readonly binary: string;
  /** Environment variable that relocates the harness config directory. */
  readonly configEnvVar: string;
  /** Prefix for the default alias name, e.g. "cc" + "work" = "ccwork". */
  readonly aliasPrefix: string;
  /** Shown after `create` to tell the user how to authenticate. */
  readonly authHint: string;
  /** File inside the config dir that proves the profile has credentials. */
  readonly credentialsFile: string;
}
