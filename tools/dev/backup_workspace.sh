#!/usr/bin/env bash
# Copies the parts of workspace/ that can't be rebuilt (characters, clip sources, game data, exports,
# reference skeletons) plus the current audit evidence to a backup folder. Rerunning updates the copy;
# nothing in the backup is deleted. Usage: tools/dev/backup_workspace.sh [destination]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="$ROOT/workspace"
DEST="${1:-/run/media/ryan/Large Storage/Backups/rigsmith-workspace}"

[ -d "$(dirname "$DEST")" ] || mkdir -p "$(dirname "$DEST")"
mkdir -p "$DEST"

cd "$WS"
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT

{
  printf '%s\n' \
    characters \
    library/sources \
    game \
    exports \
    rigdev/gt \
    rigdev/gtjoints \
    rigdev/joints.json \
    audits/2026-10-27-hand-search \
    audits/2026-10-27-refine/all-before
  # Each audit's written reports and top-level JSON results.
  find audits -mindepth 2 -maxdepth 2 -type f \( -name '*.md' -o -name '*.json' \)
} > "$LIST"

# -rt rather than -a: the default destination is NTFS, which has no Unix owners or permissions.
rsync -rt --info=stats1,progress2 --files-from="$LIST" -r "$WS/" "$DEST/"

date -Is > "$DEST/BACKED_UP_AT"
(cd "$ROOT" && git rev-parse HEAD) > "$DEST/SOURCE_COMMIT"
echo "Backed up to $DEST"
