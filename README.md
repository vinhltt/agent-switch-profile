# agent-switch-profile

Run several Claude Code logins side by side, one alias each.

Claude Code keeps its state in a single directory, so a second account means
logging the first one out. `asp` gives each account its own config directory and
writes you a shell alias that points Claude Code at it:

```bash
asp create work        # → alias ccwork
asp create personal    # → alias ccpersonal
```

```bash
ccwork        # Claude Code, logged in as work
ccpersonal    # Claude Code, logged in as personal — in another terminal, at the same time
```

No daemon, no shim, no "current profile" to remember. The alias sets
`CLAUDE_CONFIG_DIR` for that one command, so two terminals can run two accounts
at once and nothing is left switched afterwards.

## Install

Not published to npm yet — install it from source. You need **git**, **Node 20.19
or newer** to run it, and **[Bun](https://bun.sh) 1.2 or newer** to build it.

```bash
git clone https://github.com/vinhltt/agent-switch-profile.git
cd agent-switch-profile
bun install
npm i -g "$(npm pack)"     # builds, packs, and installs the `asp` command
```

`npm pack` runs the build for you, and the installed copy contains everything it
needs, so you can move or delete the clone afterwards.

```bash
asp --version
```

To update, pull and run the same install line again. To remove it:

```bash
npm rm -g agent-switch-profile
```

**Linking the clone instead**, if you are working on `asp` itself:

```bash
bun run build && npm i -g .
```

That points the global `asp` at your working tree, so a rebuild takes effect
immediately — but the command breaks if you move or delete the clone, and
`npm i -g .` does not build, so run `bun run build` yourself after each change.

If you use nvm, `asp` lands in the Node version active at install time; switching
versions hides it until you install it there too.

Requires **Linux or WSL** and **bash or zsh**. Claude Code itself must already be
installed.

macOS, Windows without WSL, and other shells (fish, csh) are out of scope for
this release — `asp` refuses with an explanation rather than writing syntax your
shell cannot read.

## Commands

### `asp create <name>`

```bash
asp create work                      # asks for the alias, defaults to ccwork
asp create work --alias w            # or name it yourself
asp create work --rc ~/.zshrc        # or pick the rc file yourself
```

Creates `~/.agent-switch-profiles/claude/<name>/` and adds the alias to your rc
file. Then open a new terminal (or `source` your rc file), run the alias, and
`/login` — that login belongs to this profile alone.

Run it again for the same profile and it does nothing, unless a previous run was
interrupted, in which case it finishes the job and says so.

### `asp list`

```
NAME      ALIAS       AUTH             IN RC  PATH
personal  ccpersonal  authenticated    yes    /home/you/.agent-switch-profiles/claude/personal
work      ccwork      unauthenticated  yes    /home/you/.agent-switch-profiles/claude/work
```

`--json` prints a stable machine-readable form on stdout and nothing else, so it
pipes cleanly:

```json
{
  "schemaVersion": 1,
  "harness": "claude",
  "profiles": [
    { "name": "work", "alias": "ccwork", "dir": "…", "authStatus": "authenticated",
      "aliasInRc": true, "createdAt": "2026-08-18T14:33:16.950Z" }
  ],
  "warnings": []
}
```

Warnings carry a `code` you can match on: `GLOBAL_CONFIG_DIR`, `ORPHAN_ALIAS`,
`MISSING_ALIAS`, `INVALID_PROFILE`, `LOOSE_PERMISSIONS`.

### `asp delete <name>`

```bash
asp delete work            # confirms first
asp delete work --force    # no confirmation; required in scripts
```

Removes the directory — including the saved login — then removes the alias, in
that order, so a failed removal never leaves a profile on disk that you can no
longer reach.

If Claude Code is still running against that profile, `asp` refuses and names the
processes. `--force` overrides that, but a running Claude Code writes its config
directory back when it exits, so quit it and run `delete` again to be sure.

## How it works

```
~/.agent-switch-profiles/
├── config.json                 # global settings
├── backups/                    # timestamped copies of your rc file
└── claude/
    ├── work/                   # this IS the CLAUDE_CONFIG_DIR
    │   ├── profile.json        # the only file asp writes here
    │   └── .credentials.json   # written by Claude Code
    └── personal/
```

In your rc file:

```bash
# >>> asp managed block v1 >>>
alias ccwork='CLAUDE_CONFIG_DIR="$HOME/.agent-switch-profiles/claude/work" claude'
# <<< asp managed block v1 <<<
```

The list of profiles is the set of directories on disk — there is no registry to
fall out of sync. Directories are `0700` and files `0600`, because they hold
OAuth credentials.

### Your rc file

`asp` only ever touches the lines between its two markers. Everything else is
preserved byte for byte, including your file's mode, its symlink if it is one,
and CRLF line endings.

Before each write it copies your rc file to
`~/.agent-switch-profiles/backups/<name>.<timestamp>` and keeps the five most
recent. To roll back:

```bash
ls -A ~/.agent-switch-profiles/backups/     # names begin with a dot
cp ~/.agent-switch-profiles/backups/.bashrc.2026-08-18T14:33:16.951Z ~/.bashrc
```

If the markers are ever damaged — one missing, or duplicated — `asp` stops and
asks you to fix them rather than guessing which lines are its own.

## Known limitations

**Aliases only exist in interactive shells.** Scripts, cron jobs, and IDEs that
spawn their own shell will not see `ccwork`; bash does not expand aliases in
non-interactive shells at all. Use the profile directory directly there:

```bash
CLAUDE_CONFIG_DIR=~/.agent-switch-profiles/claude/work claude -p "…"
```

**Deleting an alias does not remove it from a shell that already loaded it.**
Run `unalias ccwork`, or open a new terminal.

**A running Claude Code recreates its config directory when it exits.** Quit the
session before deleting its profile.

**`CLAUDE_CONFIG_DIR` set globally in your shell** is reported by `list` as a
warning. The aliases still win, because they set the variable per command.

**rc files symlinked outside your home directory are refused.** `asp` follows a
symlink that stays under `$HOME`, but will not write through one pointing
elsewhere.

## Roadmap

An npm release, so installing does not need a clone or Bun; other harnesses
(codex, gemini, opencode) through the same adapter interface; macOS once Keychain
isolation can be verified; an `asp exec <profile> -- <cmd>` form for scripts and
cron.

## Development

```bash
bun install
bun test           # unit + integration; nothing touches your real $HOME
bun run typecheck
bun run build      # dist/cli.js, runs under plain Node
```

Integration tests spawn the built `dist/cli.js` under `node` in a temporary
`HOME`, so a bundle that only works under Bun fails them.

## License

MIT
