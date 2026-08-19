import * as fs from "node:fs";
import * as path from "node:path";

import { DIR_MODE, FILE_MODE, storeRoot } from "./paths";
import { ValidationError } from "./validate";

export const STORE_CONFIG_VERSION = 1;
export const STORE_CONFIG_FILENAME = "config.json";

/**
 * Global settings only. The list of profiles is never stored here — it is the
 * set of directories on disk, so there is nothing to keep in sync.
 */
export interface StoreConfig {
  version: number;
  defaultHarness: string;
  defaultRcFile: string | null;
}

export const DEFAULT_STORE_CONFIG: StoreConfig = {
  version: STORE_CONFIG_VERSION,
  defaultHarness: "claude",
  defaultRcFile: null,
};

export function storeConfigPath(): string {
  return path.join(storeRoot(), STORE_CONFIG_FILENAME);
}

/** Missing file means "never written yet" and yields defaults. */
export function readStoreConfig(): StoreConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(storeConfigPath(), "utf8");
  } catch {
    return { ...DEFAULT_STORE_CONFIG };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ValidationError(
      `${storeConfigPath()} is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError(`${storeConfigPath()} must contain a JSON object`);
  }

  const config = parsed as Partial<StoreConfig>;
  if (config.version !== STORE_CONFIG_VERSION) {
    throw new ValidationError(
      `${storeConfigPath()} has version ${String(config.version)}, this asp understands ` +
        `${STORE_CONFIG_VERSION} — upgrade asp instead of editing the file`,
    );
  }

  return {
    version: STORE_CONFIG_VERSION,
    defaultHarness:
      typeof config.defaultHarness === "string" && config.defaultHarness.length > 0
        ? config.defaultHarness
        : DEFAULT_STORE_CONFIG.defaultHarness,
    defaultRcFile: typeof config.defaultRcFile === "string" ? config.defaultRcFile : null,
  };
}

export function writeStoreConfig(config: StoreConfig): void {
  fs.mkdirSync(storeRoot(), { recursive: true, mode: DIR_MODE });
  fs.writeFileSync(storeConfigPath(), `${JSON.stringify(config, null, 2)}\n`, {
    mode: FILE_MODE,
  });
}
