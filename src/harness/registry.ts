import { ValidationError } from "../validate";

import { claudeAdapter } from "./claude";
import type { HarnessAdapter } from "./types";

const ADAPTERS: readonly HarnessAdapter[] = [claudeAdapter];

export function listHarnessNames(): string[] {
  return ADAPTERS.map((adapter) => adapter.name);
}

export function findHarness(name: string): HarnessAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.name === name);
}

export function getHarness(name: unknown): HarnessAdapter {
  if (typeof name !== "string" || name.length === 0) {
    throw new ValidationError(`harness is required (supported: ${listHarnessNames().join(", ")})`);
  }
  const adapter = findHarness(name);
  if (!adapter) {
    throw new ValidationError(
      `unknown harness ${JSON.stringify(name)} (supported: ${listHarnessNames().join(", ")})`,
    );
  }
  return adapter;
}
