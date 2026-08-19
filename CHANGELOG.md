# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-19

### Added
- Run several Claude Code accounts side by side — each profile gets its own
  config directory and a shell alias that points Claude Code at it for that one
  command. No daemon, no shim, no current profile to remember.
- `asp create <name>` creates the profile directory and writes a `cc<name>`
  shell alias into your bash or zsh rc file. `--alias` picks a different alias
  name, `--rc` a different rc file.
- `asp list` shows every profile with its alias and auth status, and warns about
  orphan aliases, missing aliases, unreadable profile metadata, loosened store
  permissions, and a globally exported `CLAUDE_CONFIG_DIR`. `--json` emits the
  same information with a schema version and a stable code per warning.
- `asp delete <name>` removes the profile directory and its alias after a
  confirmation prompt; `--force` skips the prompt.
- `--harness` selects the target harness and falls back to the default recorded
  in the store config. Claude Code is the only harness in this release.
- Shell rc edits are confined to a versioned managed block: the write takes a
  lock, keeps a timestamped backup under `~/.agent-switch-profiles/backups/`
  (the last five), follows rc symlinks, and preserves file mode, line endings,
  and every byte outside the block. A failed `create` rolls the rc file back and
  removes the half-created profile.
- Profile directories are created `0700` and profile metadata `0600`, so OAuth
  credentials are not readable by other users on the machine.
- Profile and alias names are validated before any side effect, so shell
  metacharacters can never reach the rc file.
- Every command exits instead of hanging when there is no terminal attached.
