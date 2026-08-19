#!/usr/bin/env bash
# Try asp end to end inside a throwaway HOME.
#
# Nothing here touches your real ~/.bashrc or ~/.claude: HOME is redirected to a
# temp directory, and `claude` is replaced by a stub that only reports which
# config dir it was handed. Delete the temp directory and no trace remains.
set -euo pipefail

CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dist/cli.js"
[ -f "$CLI" ] || { echo "build first: bun run build"; exit 1; }

SANDBOX=$(mktemp -d /tmp/asp-try-XXXXXX)
trap 'echo; echo "sandbox left at $SANDBOX (rm -rf it when done)"' EXIT

mkdir -p "$SANDBOX/bin"
printf '#!/usr/bin/env bash\necho "  [stub claude] CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR"\n' \
  > "$SANDBOX/bin/claude"
chmod +x "$SANDBOX/bin/claude"

printf '# my shell config\nexport EDITOR=vim\nalias ll="ls -la"\n' > "$SANDBOX/.bashrc"

export HOME="$SANDBOX"
export SHELL=/bin/bash
export PATH="$SANDBOX/bin:$PATH"

asp() { echo; echo "\$ asp $*"; node "$CLI" "$@"; }

echo "=== sandbox HOME: $SANDBOX"
echo
echo "--- your .bashrc before ---"
cat "$SANDBOX/.bashrc"

asp --harness claude create work --alias ccwork
asp --harness claude create personal --alias ccpersonal
asp --harness claude list

echo
echo "--- .bashrc after: your lines are untouched, the block is appended ---"
cat "$SANDBOX/.bashrc"

echo
echo "--- the aliases actually run (stub claude reports its config dir) ---"
bash -s <<'SHELL'
shopt -s expand_aliases
source "$HOME/.bashrc"
echo "\$ ccwork"; ccwork
echo "\$ ccpersonal"; ccpersonal
SHELL

echo
echo "--- each profile is a separate config dir ---"
find "$SANDBOX/.agent-switch-profiles" -maxdepth 3 | sort

asp --harness claude list --json

asp --harness claude delete work --force
echo
echo "--- .bashrc after delete: one alias left ---"
cat "$SANDBOX/.bashrc"

asp --harness claude delete personal --force
echo
echo "--- .bashrc after deleting everything: byte-identical to the start ---"
cat "$SANDBOX/.bashrc"

echo
echo "--- rc backups asp kept along the way (names start with a dot) ---"
ls -1A "$SANDBOX/.agent-switch-profiles/backups/"
echo
echo "restore any of them with:  cp <backup> ~/.bashrc"
