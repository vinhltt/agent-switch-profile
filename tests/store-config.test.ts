import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";

import {
  DEFAULT_STORE_CONFIG,
  STORE_CONFIG_VERSION,
  readStoreConfig,
  storeConfigPath,
  writeStoreConfig,
} from "../src/store-config";
import { ValidationError } from "../src/validate";

import { createTempHome, modeOf, type TempHome } from "./helpers/temp-home";

let tmp: TempHome;

beforeEach(() => {
  tmp = createTempHome();
});
afterEach(() => {
  tmp.cleanup();
});

describe("store config", () => {
  test("returns defaults when nothing has been written", () => {
    expect(readStoreConfig()).toEqual(DEFAULT_STORE_CONFIG);
    expect(fs.existsSync(tmp.store)).toBe(false);
  });

  test("round-trips through disk with owner-only permissions", () => {
    writeStoreConfig({ ...DEFAULT_STORE_CONFIG, defaultRcFile: tmp.rcFile });

    expect(modeOf(storeConfigPath())).toBe(0o600);
    expect(modeOf(tmp.store)).toBe(0o700);
    expect(readStoreConfig().defaultRcFile).toBe(tmp.rcFile);
  });

  test("refuses a config written by a newer asp", () => {
    writeStoreConfig(DEFAULT_STORE_CONFIG);
    fs.writeFileSync(storeConfigPath(), JSON.stringify({ version: STORE_CONFIG_VERSION + 1 }));

    expect(() => readStoreConfig()).toThrow(ValidationError);
    expect(() => readStoreConfig()).toThrow(/upgrade asp/);
  });

  test("refuses malformed JSON instead of silently resetting", () => {
    writeStoreConfig(DEFAULT_STORE_CONFIG);
    fs.writeFileSync(storeConfigPath(), "{ not json");

    expect(() => readStoreConfig()).toThrow(ValidationError);
  });

  test("refuses a JSON array", () => {
    writeStoreConfig(DEFAULT_STORE_CONFIG);
    fs.writeFileSync(storeConfigPath(), "[]");

    expect(() => readStoreConfig()).toThrow(/JSON object/);
  });

  test("falls back to a sane harness when the field is unusable", () => {
    writeStoreConfig(DEFAULT_STORE_CONFIG);
    fs.writeFileSync(
      storeConfigPath(),
      JSON.stringify({ version: STORE_CONFIG_VERSION, defaultHarness: 42, defaultRcFile: [] }),
    );

    expect(readStoreConfig()).toEqual(DEFAULT_STORE_CONFIG);
  });
});
