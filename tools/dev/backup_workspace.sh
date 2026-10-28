#!/usr/bin/env bash
# Copies the parts of workspace/ that can't be rebuilt (settings, characters with their journals and v1
# backups, clip sources, game data, old exports, reference skeletons) plus the current audit evidence to a
# backup folder. Rerunning updates the copy; nothing in the backup is deleted. Paths that don't exist in this
# workspace are skipped. Usage: tools/dev/backup_workspace.sh [destination]
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
  for p in \
    settings.json \
    characters \
    library/sources \
    game \
    exports \
    rigdev/gt \
    rigdev/gtjoints \
    rigdev/joints.json \
    audits/2026-10-27-hand-search \
    audits/2026-10-27-refine/all-before
  do
    if [ -e "$p" ]; then printf '%s\n' "$p"; fi
  done
  # Each audit's written reports and top-level JSON results.
  if [ -d audits ]; then find audits -mindepth 2 -maxdepth 2 -type f \( -name '*.md' -o -name '*.json' \); fi
} > "$LIST"

# -rt rather than -a: the default destination is NTFS, which has no Unix owners or permissions.
rsync -rt --info=stats1,progress2 --files-from="$LIST" -r "$WS/" "$DEST/"

date -Is > "$DEST/BACKED_UP_AT"
(cd "$ROOT" && git rev-parse HEAD) > "$DEST/SOURCE_COMMIT"
echo "Backed up to $DEST"
