import * as fs from "node:fs";
import * as path from "node:path";

import { DIR_MODE, FILE_MODE, backupsDirFor } from "../paths";
import { ValidationError, validateAliasName } from "../validate";

/**
 * The marker carries its own version so a future format change can refuse to be
 * rewritten by an older asp instead of mangling it.
 */
export const BLOCK_VERSION = 1;
export const blockStartMarker = (version = BLOCK_VERSION): string =>
  `# >>> asp managed block v${version} >>>`;
export const blockEndMarker = (version = BLOCK_VERSION): string =>
  `# <<< asp managed block v${version} <<<`;

const START_MARKER_PATTERN = /^# >>> asp managed block v(\d+) >>>$/;
const END_MARKER_PATTERN = /^# <<< asp managed block v(\d+) <<<$/;

const LOCK_SUFFIX = ".asp.lock";
const LOCK_STALE_MS = 10_000;
const BACKUPS_TO_KEEP = 5;

export interface AliasEntry {
  alias: string;
  /** Always absolute: `$HOME` is expanded on read and re-introduced on write. */
  profileDir: string;
  envVar: string;
  binary: string;
}

export interface RcBlock {
  present: boolean;
  version: number;
  entries: AliasEntry[];
  /** Lines asp did not write and does not understand. Never dropped. */
  unknownLines: string[];
}

// ---------------------------------------------------------------------------
// Shell quoting
// ---------------------------------------------------------------------------

/** Wrap a string so a POSIX shell reads it back verbatim: a'b -> 'a'\''b' */
export function shellSingleQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/** Inverse of shellSingleQuote. Returns null for anything we would not emit. */
export function parseShellSingleQuoted(text: string): string | null {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end === -1) return null;
      out += text.slice(index + 1, end);
      index = end + 1;
    } else if (char === "\\" && index + 1 < text.length) {
      out += text[index + 1];
      index += 2;
    } else {
      return null;
    }
  }
  return out;
}

/** Escape the characters a double-quoted shell word still interprets. */
function escapeForDoubleQuotes(value: string): string {
  return value.replace(/([\\$`"])/g, "\\$1");
}

function unescapeFromDoubleQuotes(value: string): string {
  return value.replace(/\\([\\$`"])/g, "$1");
}

function isUnderHome(target: string, homeDir: string): boolean {
  return target === homeDir || target.startsWith(homeDir + path.sep);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the config-dir argument. Paths under the home directory are emitted as
 * `$HOME/...` so the line survives a moved or renamed home; `$HOME` expands when
 * the alias runs, not when it is defined, so the surrounding single quotes are
 * no obstacle.
 */
function renderProfileDirToken(profileDir: string, homeDir: string): string {
  if (isUnderHome(profileDir, homeDir)) {
    return `$HOME${escapeForDoubleQuotes(profileDir.slice(homeDir.length))}`;
  }
  return escapeForDoubleQuotes(profileDir);
}

export function renderAliasLine(entry: AliasEntry, homeDir: string): string {
  if (entry.profileDir.includes("\n") || homeDir.includes("\n")) {
    throw new ValidationError(
      "refusing to write an alias for a path containing a newline: it cannot be expressed safely in a shell rc file",
    );
  }
  validateAliasName(entry.alias);

  const body = `${entry.envVar}="${renderProfileDirToken(entry.profileDir, homeDir)}" ${entry.binary}`;
  return `alias ${entry.alias}=${shellSingleQuote(body)}`;
}

const ALIAS_LINE_PATTERN = /^alias ([A-Za-z0-9_-]+)=(.+)$/;
const ALIAS_BODY_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)="(.*)" (\S+)$/;

/** Returns null when the line is not an alias asp could have written. */
export function parseAliasLine(line: string, homeDir: string): AliasEntry | null {
  const outer = ALIAS_LINE_PATTERN.exec(line);
  if (!outer) return null;

  const [, alias, quoted] = outer as unknown as [string, string, string];
  try {
    validateAliasName(alias);
  } catch {
    return null;
  }

  const body = parseShellSingleQuoted(quoted);
  if (body === null) return null;

  const inner = ALIAS_BODY_PATTERN.exec(body);
  if (!inner) return null;

  const [, envVar, quotedPath, binary] = inner as unknown as [string, string, string, string];
  const rawPath = unescapeFromDoubleQuotes(quotedPath);

  // Accept both what we render and what a user may have typed by hand.
  let profileDir: string;
  if (rawPath === "$HOME" || rawPath === "${HOME}") {
    profileDir = homeDir;
  } else if (rawPath.startsWith("$HOME/")) {
    profileDir = path.join(homeDir, rawPath.slice("$HOME/".length));
  } else if (rawPath.startsWith("${HOME}/")) {
    profileDir = path.join(homeDir, rawPath.slice("${HOME}/".length));
  } else if (path.isAbsolute(rawPath)) {
    profileDir = path.normalize(rawPath);
  } else {
    return null;
  }

  return { alias, profileDir, envVar, binary };
}

// ---------------------------------------------------------------------------
// Physical lines — the file is spliced by byte offset so that everything
// outside the managed block survives byte-for-byte.
// ---------------------------------------------------------------------------

interface PhysicalLine {
  text: string;
  ending: string;
  start: number;
  end: number;
}

function scanLines(content: string): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  let index = 0;

  while (index < content.length) {
    const newline = content.indexOf("\n", index);
    if (newline === -1) {
      lines.push({ text: content.slice(index), ending: "", start: index, end: content.length });
      break;
    }
    let text = content.slice(index, newline);
    let ending = "\n";
    if (text.endsWith("\r")) {
      text = text.slice(0, -1);
      ending = "\r\n";
    }
    lines.push({ text, ending, start: index, end: newline + 1 });
    index = newline + 1;
  }
  return lines;
}

/** WSL users edit rc files with Windows editors; keep whatever they already use. */
export function detectLineEnding(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

interface LocatedBlock {
  startLine: PhysicalLine;
  endLine: PhysicalLine;
  startIndex: number;
  endIndex: number;
  version: number;
  bodyLines: PhysicalLine[];
}

function locateBlock(lines: readonly PhysicalLine[]): LocatedBlock | null {
  const starts: { line: PhysicalLine; version: number; index: number }[] = [];
  const ends: { line: PhysicalLine; version: number; index: number }[] = [];

  lines.forEach((line, index) => {
    const start = START_MARKER_PATTERN.exec(line.text);
    if (start) starts.push({ line, version: Number(start[1]), index });
    const end = END_MARKER_PATTERN.exec(line.text);
    if (end) ends.push({ line, version: Number(end[1]), index });
  });

  if (starts.length === 0 && ends.length === 0) return null;

  if (starts.length !== 1 || ends.length !== 1) {
    throw new ValidationError(
      `the asp managed block markers are damaged (${starts.length} opening, ${ends.length} closing). ` +
        `Fix them by hand — asp will not guess which lines it owns.`,
    );
  }

  const [start] = starts as [{ line: PhysicalLine; version: number; index: number }];
  const [end] = ends as [{ line: PhysicalLine; version: number; index: number }];

  if (end.index < start.index) {
    throw new ValidationError(
      "the asp managed block closes before it opens. Fix the markers by hand.",
    );
  }
  if (start.version !== end.version) {
    throw new ValidationError(
      `the asp managed block opens at v${start.version} and closes at v${end.version}. ` +
        `Fix the markers by hand.`,
    );
  }

  return {
    startLine: start.line,
    endLine: end.line,
    startIndex: start.index,
    endIndex: end.index,
    version: start.version,
    bodyLines: lines.slice(start.index + 1, end.index),
  };
}

function assertSupportedVersion(version: number): void {
  if (version > BLOCK_VERSION) {
    throw new ValidationError(
      `this rc file has an asp managed block v${version}, but this asp understands v${BLOCK_VERSION}. ` +
        `Upgrade asp (npm i -g agent-switch-profile) rather than letting it rewrite a format it does not know.`,
    );
  }
  if (version < BLOCK_VERSION) {
    throw new ValidationError(
      `unknown asp managed block version v${version} (this asp writes v${BLOCK_VERSION})`,
    );
  }
}

const EMPTY_BLOCK: RcBlock = { present: false, version: BLOCK_VERSION, entries: [], unknownLines: [] };

export function parseBlock(content: string, homeDir: string): RcBlock {
  const located = locateBlock(scanLines(content));
  if (!located) return { ...EMPTY_BLOCK, entries: [], unknownLines: [] };

  assertSupportedVersion(located.version);

  const entries: AliasEntry[] = [];
  const unknownLines: string[] = [];

  for (const line of located.bodyLines) {
    const entry = parseAliasLine(line.text, homeDir);
    if (entry) {
      entries.push(entry);
    } else if (line.text.length > 0) {
      unknownLines.push(line.text);
    }
  }

  return { present: true, version: located.version, entries, unknownLines };
}

/** Read the managed block from disk. A missing rc file simply has no block. */
export function readBlock(rcPath: string, homeDir: string): RcBlock {
  let content: string;
  try {
    content = fs.readFileSync(rcPath, "utf8");
  } catch {
    return { ...EMPTY_BLOCK, entries: [], unknownLines: [] };
  }
  return parseBlock(content, homeDir);
}

export function serializeBlock(block: RcBlock, homeDir: string, lineEnding: string): string {
  const sorted = [...block.entries].sort((a, b) => a.alias.localeCompare(b.alias));
  const lines = [
    blockStartMarker(BLOCK_VERSION),
    ...sorted.map((entry) => renderAliasLine(entry, homeDir)),
    ...block.unknownLines,
    blockEndMarker(BLOCK_VERSION),
  ];
  return lines.map((line) => line + lineEnding).join("");
}

export function hasAlias(block: RcBlock, alias: string): boolean {
  return block.entries.some((entry) => entry.alias === alias);
}

/** Entries whose profile directory no longer exists on disk. */
export function findOrphanEntries(block: RcBlock): AliasEntry[] {
  return block.entries.filter((entry) => !fs.existsSync(entry.profileDir));
}

/**
 * An `alias <name>=` defined outside the managed block. asp must not silently
 * shadow a definition the user wrote themselves.
 */
export function findCollision(content: string, alias: string): string | null {
  const lines = scanLines(content);
  const located = locateBlock(lines);
  const pattern = new RegExp(`^\\s*alias\\s+${alias.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}=`);

  for (const [index, line] of lines.entries()) {
    if (located && index >= located.startIndex && index <= located.endIndex) continue;
    if (pattern.test(line.text)) return line.text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Write pipeline: lock -> read -> parse -> mutate -> sanity check -> backup ->
// temp file -> fchmod -> fsync -> rename -> fsync dir
// ---------------------------------------------------------------------------

interface Lock {
  release(): void;
  /** PID of the stale holder whose lock was taken over, if any. */
  stolenFrom: string | null;
}

function acquireLock(rcPath: string): Lock {
  const lockPath = rcPath + LOCK_SUFFIX;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx", FILE_MODE);
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return {
        stolenFrom: null,
        release: () => {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // Already gone: nothing to release.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      let age: number;
      let holder = "unknown";
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
        holder = fs.readFileSync(lockPath, "utf8").trim() || "unknown";
      } catch {
        continue; // Vanished between open and stat; retry.
      }

      if (age <= LOCK_STALE_MS) {
        throw new ValidationError(
          `another asp run (pid ${holder}) is editing ${rcPath}. Wait for it to finish and retry.`,
        );
      }

      // Older than any run should take: assume the holder was killed.
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Someone else cleaned up first; the retry will find out.
      }
      const stolen = acquireLock(rcPath);
      return { ...stolen, stolenFrom: holder };
    }
  }

  throw new ValidationError(`could not acquire the lock on ${rcPath}`);
}

function pruneBackups(dir: string, basename: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  // ISO 8601 sorts lexicographically, so the newest names sort last.
  const mine = names.filter((name) => name.startsWith(`${basename}.`)).sort();
  for (const name of mine.slice(0, Math.max(0, mine.length - BACKUPS_TO_KEEP))) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      // Best effort: a backup we cannot delete is not a reason to fail the write.
    }
  }
}

/**
 * Backups live in the store, not next to the rc file, so they neither clutter
 * the home directory nor get swept into a dotfiles repository. An existing
 * backup is never overwritten.
 */
function writeBackup(realRcPath: string, content: Buffer, homeDir: string): string {
  const dir = backupsDirFor(homeDir);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });

  const basename = path.basename(realRcPath);
  const stamp = new Date().toISOString();

  for (let suffix = 0; suffix < 100; suffix += 1) {
    const target = path.join(dir, suffix === 0 ? `${basename}.${stamp}` : `${basename}.${stamp}.${suffix}`);
    try {
      const fd = fs.openSync(target, "wx", FILE_MODE);
      try {
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      pruneBackups(dir, basename);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not find an unused backup name for ${basename} in ${dir}`);
}

function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Some filesystems refuse to fsync a directory; the data fsync already ran.
    if (code !== "EINVAL" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EISDIR") {
      throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export interface RcWriteResult {
  /** Path as given; still a symlink afterwards if it was one before. */
  rcPath: string;
  /** File the bytes actually landed in. */
  realPath: string;
  backupPath: string | null;
  changed: boolean;
  warnings: string[];
}

function readExisting(realPath: string): { content: Buffer; stats: fs.Stats } | null {
  try {
    const stats = fs.statSync(realPath);
    return { content: fs.readFileSync(realPath), stats };
  } catch {
    return null;
  }
}

function assertWritable(realPath: string, stats: fs.Stats): void {
  if (stats.nlink > 1) {
    throw new ValidationError(
      `${realPath} has ${stats.nlink} hard links. Replacing it would silently detach the others — ` +
        `resolve that by hand first.`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new ValidationError(
      `${realPath} is owned by uid ${stats.uid}, not by you (uid ${uid}). Refusing to take it over.`,
    );
  }
}

function atomicWrite(realPath: string, content: string, mode: number): void {
  const dir = path.dirname(realPath);
  // Same directory as the target, so the rename is always within one filesystem.
  const tempPath = path.join(dir, `.${path.basename(realPath)}.asp-${process.pid}-${Date.now()}`);

  const fd = fs.openSync(tempPath, "wx", FILE_MODE);
  try {
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Nothing better to do while already failing.
    }
    throw error;
  }
  fs.closeSync(fd);

  try {
    fs.renameSync(tempPath, realPath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Nothing better to do while already failing.
    }
    throw error;
  }
  fsyncDir(dir);
}

/**
 * Read the block, hand it to `mutate`, and write the result back. Returning the
 * block unchanged (byte-identical output) skips the write entirely, so repeating
 * a command neither churns the rc file nor burns a backup slot.
 */
export function rewriteBlock(
  rcPath: string,
  homeDir: string,
  mutate: (block: RcBlock) => RcBlock,
): RcWriteResult {
  const lock = acquireLock(rcPath);
  const warnings: string[] = [];
  if (lock.stolenFrom) {
    warnings.push(
      `took over a stale lock left by pid ${lock.stolenFrom} on ${rcPath} (older than ${LOCK_STALE_MS / 1000}s)`,
    );
  }

  try {
    // Write through the symlink, not over it, so dotfile managers keep working.
    let realPath: string;
    try {
      realPath = fs.realpathSync(rcPath);
    } catch {
      realPath = path.resolve(rcPath);
    }

    const existing = readExisting(realPath);
    if (existing) assertWritable(realPath, existing.stats);

    const original = existing ? existing.content.toString("utf8") : "";
    const lineEnding = existing ? detectLineEnding(original) : "\n";

    // Parsing before anything else: damaged markers must stop the run while the
    // file is still untouched.
    const block = parseBlock(original, homeDir);
    const next = mutate(block);

    const rendered =
      next.entries.length === 0 && next.unknownLines.length === 0
        ? null
        : serializeBlock(next, homeDir, lineEnding);
    const updated = spliceBlock(original, rendered, lineEnding);

    if (updated === original) {
      return { rcPath, realPath, backupPath: null, changed: false, warnings };
    }

    // The file must not have moved under us between the read and the write.
    // Checked before the backup so an aborted run leaves nothing behind at all.
    if (existing) {
      const now = fs.statSync(realPath);
      if (now.mtimeMs !== existing.stats.mtimeMs || now.size !== existing.stats.size) {
        throw new ValidationError(
          `${realPath} changed while asp was editing it. Nothing was written — re-run the command.`,
        );
      }
    }

    let backupPath: string | null = null;
    if (existing && existing.content.length > 0) {
      backupPath = writeBackup(realPath, existing.content, homeDir);
    } else if (existing) {
      assertEmptyFileIsExpected(realPath, homeDir);
    }

    atomicWrite(realPath, updated, existing ? existing.stats.mode & 0o777 : FILE_MODE);
    return { rcPath, realPath, backupPath, changed: true, warnings };
  } finally {
    lock.release();
  }
}

/**
 * An rc file that is suddenly empty while a non-empty backup exists is a sign of
 * earlier damage. Backing that up would push the good history out of the ring.
 */
function assertEmptyFileIsExpected(realPath: string, homeDir: string): void {
  const dir = backupsDirFor(homeDir);
  const basename = path.basename(realPath);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const latest = names.filter((name) => name.startsWith(`${basename}.`)).sort().pop();
  if (!latest) return;

  if (fs.statSync(path.join(dir, latest)).size > 0) {
    throw new ValidationError(
      `${realPath} is empty but ${path.join(dir, latest)} is not. That looks like earlier damage — ` +
        `restore the backup before letting asp write again.`,
    );
  }
}

/** Replace, insert, or drop the managed block while leaving every other byte alone. */
function spliceBlock(content: string, rendered: string | null, lineEnding: string): string {
  const located = locateBlock(scanLines(content));

  if (located) {
    assertSupportedVersion(located.version);
    const before = content.slice(0, located.startLine.start);
    const after = content.slice(located.endLine.end);
    if (rendered === null) return before + after;
    // Reuse the closing marker's ending so a file without a trailing newline
    // does not grow one.
    const body = located.endLine.ending === "" ? rendered.replace(/(\r?\n)$/, "") : rendered;
    return before + body + after;
  }

  if (rendered === null) return content;
  if (content.length === 0) return rendered;
  return content.endsWith("\n") ? content + rendered : content + lineEnding + rendered;
}

export function upsertAlias(rcPath: string, homeDir: string, entry: AliasEntry): RcWriteResult {
  validateAliasName(entry.alias);
  return rewriteBlock(rcPath, homeDir, (block) => ({
    ...block,
    present: true,
    entries: [...block.entries.filter((existing) => existing.alias !== entry.alias), entry],
  }));
}

export function removeAlias(rcPath: string, homeDir: string, alias: string): RcWriteResult {
  return rewriteBlock(rcPath, homeDir, (block) => ({
    ...block,
    entries: block.entries.filter((entry) => entry.alias !== alias),
  }));
}

// ---------------------------------------------------------------------------
// Rollback support
// ---------------------------------------------------------------------------

export interface RcPreImage {
  rcPath: string;
  realPath: string;
  existed: boolean;
  content: Buffer | null;
  mode: number | null;
}

/** Snapshot taken before a command starts, so a later failure can be undone. */
export function captureRcPreImage(rcPath: string): RcPreImage {
  let realPath: string;
  try {
    realPath = fs.realpathSync(rcPath);
  } catch {
    realPath = path.resolve(rcPath);
  }

  const existing = readExisting(realPath);
  return {
    rcPath,
    realPath,
    existed: existing !== null,
    content: existing?.content ?? null,
    mode: existing ? existing.stats.mode & 0o777 : null,
  };
}

/**
 * Put the rc file back exactly as it was. No backup is taken: this undoes a
 * change asp just made, and the pre-image is the state being restored.
 */
export function restoreRcPreImage(pre: RcPreImage): void {
  if (!pre.existed) {
    try {
      fs.unlinkSync(pre.realPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  atomicWrite(pre.realPath, (pre.content as Buffer).toString("utf8"), pre.mode ?? FILE_MODE);
}
