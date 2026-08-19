import type { HarnessAdapter } from "./types";

export const claudeAdapter: HarnessAdapter = {
  name: "claude",
  binary: "claude",
  configEnvVar: "CLAUDE_CONFIG_DIR",
  aliasPrefix: "cc",
  authHint: "run the alias, then /login inside Claude Code",
  credentialsFile: ".credentials.json",
};
