#!/bin/sh
# Wire this worktree's `data/images` to the shared image store at
# `<repo-parent>/.shared/images`, so captures dedupe across worktrees via
# content-addressing. The DB (`data/visual-compare.sqlite`) stays
# per-worktree on purpose — schema changes in one branch shouldn't
# corrupt another branch's data.
#
# Idempotent: skips work when already symlinked correctly, fails loud
# when `data/images` exists with non-empty contents that aren't already
# in the shared dir (so we don't silently throw away captures).
#
# Usage:
#   scripts/share-images-dir.sh
#
# Layout it produces:
#   /<repo-parent>/.shared/images/sha256/AB/<sha>.png   ← real files
#   /<repo-parent>/<worktree>/data/images               ← symlink
set -eu

WORKTREE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_PARENT="$(cd "$WORKTREE_ROOT/.." && pwd)"
SHARED_DIR="$REPO_PARENT/.shared/images"
WORKTREE_IMAGES="$WORKTREE_ROOT/data/images"

mkdir -p "$SHARED_DIR" "$WORKTREE_ROOT/data"

# Already wired? Verify the symlink target matches and exit clean.
if [ -L "$WORKTREE_IMAGES" ]; then
  current_target="$(readlink "$WORKTREE_IMAGES")"
  case "$current_target" in
    "$SHARED_DIR"|*"/.shared/images"|"../../.shared/images")
      echo "[share-images-dir] already symlinked: $WORKTREE_IMAGES -> $current_target"
      exit 0
      ;;
    *)
      echo "[share-images-dir] $WORKTREE_IMAGES -> $current_target (unexpected target; not touching)" >&2
      exit 1
      ;;
  esac
fi

# Plain directory case: if it has contents we haven't seen in the shared
# dir, refuse rather than risk data loss. The user can move things
# manually and re-run.
if [ -d "$WORKTREE_IMAGES" ]; then
  if [ -z "$(ls -A "$WORKTREE_IMAGES" 2>/dev/null)" ]; then
    rmdir "$WORKTREE_IMAGES"
  else
    echo "[share-images-dir] $WORKTREE_IMAGES is a non-empty directory." >&2
    echo "  Move its contents into $SHARED_DIR (rsync -a then rm -rf) and re-run." >&2
    exit 2
  fi
fi

ln -s "../../.shared/images" "$WORKTREE_IMAGES"
echo "[share-images-dir] linked: $WORKTREE_IMAGES -> ../../.shared/images"
echo "                  shared:  $SHARED_DIR"
