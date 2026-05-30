#!/bin/bash
# migrate-games.sh — one-off script to reorganise games files into games/{tenant}/ folders
# Run via GitHub Actions: mode=migrate-games (no season needed)
# Safe to run multiple times — skips files already in the right place

set -e

echo "🗂 Migrating games files into games/{tenant}/ folders..."

MOVED=0
SKIPPED=0

# Handle games-{tenant}-{seasonId}.json → games/{tenant}/{seasonId}.json
for f in games-*-*.json; do
  [ -f "$f" ] || continue  # skip if no matches

  # Extract tenant and seasonId from filename
  # Format: games-{tenant}-{seasonId}.json
  without_prefix="${f#games-}"           # bv-15908988.json
  tenant="${without_prefix%%-*}"         # bv
  seasonId="${without_prefix#*-}"        # 15908988.json
  seasonId="${seasonId%.json}"           # 15908988

  dest_dir="games/${tenant}"
  dest_file="${dest_dir}/${seasonId}.json"

  mkdir -p "$dest_dir"
  git mv "$f" "$dest_file"
  echo "  ✓ $f → $dest_file"
  MOVED=$((MOVED + 1))
done

echo ""
echo "✅ Moved ${MOVED} files"

if [ $MOVED -eq 0 ]; then
  echo "   Nothing to migrate — files may already be in the right place"
fi
