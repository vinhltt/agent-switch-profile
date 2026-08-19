/** Raised whenever untrusted input fails a safety check, before any side effect. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Profile names double as directory names, so they stay kebab-case and path-free. */
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Alias names are interpolated into a shell rc file, so the charset is narrowed
 * to what cannot terminate a statement, start a substitution, or quote-escape:
 * lowercase letters, digits, `-` and `_`, never leading with a digit or `-`.
 */
export const ALIAS_NAME_PATTERN = /^[a-z_][a-z0-9_-]*$/;

export const MAX_NAME_LENGTH = 32;

export function validateProfileName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new ValidationError("profile name is required");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new ValidationError(
      `profile name is too long (${name.length} > ${MAX_NAME_LENGTH}): ${JSON.stringify(name)}`,
    );
  }
  // Redundant against the pattern, but keeps the traversal refusal explicit.
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new ValidationError(`profile name must not contain a path: ${JSON.stringify(name)}`);
  }
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new ValidationError(
      `invalid profile name ${JSON.stringify(name)}: use lowercase letters, digits and "-", ` +
        `starting with a letter or digit`,
    );
  }
  return name;
}

export function validateAliasName(alias: unknown): string {
  if (typeof alias !== "string" || alias.length === 0) {
    throw new ValidationError("alias name is required");
  }
  if (alias.length > MAX_NAME_LENGTH) {
    throw new ValidationError(
      `alias name is too long (${alias.length} > ${MAX_NAME_LENGTH}): ${JSON.stringify(alias)}`,
    );
  }
  if (!ALIAS_NAME_PATTERN.test(alias)) {
    throw new ValidationError(
      `invalid alias name ${JSON.stringify(alias)}: use lowercase letters, digits, "-" and "_", ` +
        `starting with a lowercase letter or "_". Quotes, spaces, "=", ";", "$", backticks and ` +
        `newlines are refused because the alias is written into your shell rc file`,
    );
  }
  return alias;
}
