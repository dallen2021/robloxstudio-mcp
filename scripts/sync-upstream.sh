#!/usr/bin/env bash
# dallen fork: merge Chrrxs/robloxstudio-mcp into a sync branch and verify it.
#
#   npm run sync-upstream                 # latest upstream release tag
#   npm run sync-upstream -- v3.5.0       # a specific tag or ref
#   npm run sync-upstream -- --check      # only report how far behind we are
#
# Works in a separate git worktree (default /tmp/rsmcp-sync-<ref>) so the live
# checkout, its dist/ and every agent's running server are never touched.
# Steps: fetch upstream, branch sync/upstream-<ref> from daniel/main, merge,
# auto-resolve version-only conflicts to <ref>-dallen.1, then npm ci, build,
# typecheck, full test suite, offline MCP smoke test and plugin artifact build.
# Stops at the first real conflict or failure and leaves the worktree for you.
# It never pushes, never merges into daniel/main and never installs the plugin.
set -euo pipefail

REPO="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
BASE_BRANCH="daniel/main"
UPSTREAM_URL="https://github.com/Chrrxs/robloxstudio-mcp.git"
NODE_BIN="${NODE_BIN:-/opt/homebrew/opt/node@24/bin}"
[ -x "$NODE_BIN/node" ] && export PATH="$NODE_BIN:$PATH"

cd "$REPO"
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
git remote set-url --push upstream DISABLED   # never push to upstream
git fetch -q upstream --tags
git fetch -q origin

latest_tag() { git tag -l 'v*' --merged upstream/main --sort=-v:refname | grep -v -- '-' | head -1; }

if [ "${1:-}" = "--check" ]; then
  base="$(git merge-base origin/$BASE_BRANCH upstream/main)"
  echo "upstream/main: $(git log -1 --format='%h %s (%ad)' --date=short upstream/main)"
  echo "latest tag:    $(latest_tag)"
  echo "branch point:  $(git describe --tags "$base" 2>/dev/null || git rev-parse --short "$base")"
  echo "behind: $(git rev-list --count origin/$BASE_BRANCH..upstream/main) upstream commits; ours: $(git rev-list --count --no-merges upstream/main..origin/$BASE_BRANCH)"
  git log --format='  %h %ad %s' --date=short origin/$BASE_BRANCH..upstream/main
  exit 0
fi

REF="${1:-$(latest_tag)}"
git rev-parse -q --verify "$REF^{commit}" >/dev/null || { echo "Unknown ref: $REF" >&2; exit 1; }
LABEL="${REF#v}"; LABEL="${LABEL//\//-}"
if [[ "$REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then VERSION="${REF#v}-dallen.1"
else VERSION="$(node -p "require('./package.json').version.replace(/-dallen\.(\d+)$/, (m, n) => '-dallen.' + (Number(n) + 1))")"; fi
BRANCH="sync/upstream-$LABEL"
WT="${SYNC_WORKTREE:-/tmp/rsmcp-sync-$LABEL}"

if git merge-base --is-ancestor "$REF" "origin/$BASE_BRANCH"; then
  echo "$BASE_BRANCH already contains $REF. Nothing to do."; exit 0
fi
[ -e "$WT" ] && { echo "$WT already exists. Remove it (git worktree remove $WT) or set SYNC_WORKTREE." >&2; exit 1; }

echo "== Merging $REF into $BRANCH at $WT (version $VERSION)"
git worktree add -q -b "$BRANCH" "$WT" "origin/$BASE_BRANCH"
cd "$WT"
if ! git merge --no-ff --no-commit "$REF" >/tmp/rsmcp-sync-merge.log 2>&1; then
  perl -e '
    my $new = shift @ARGV; local $/;
    for my $f (@ARGV) { open my $h, "<", $f or next; my $s = <$h>; close $h;
      $s =~ s/^<<<<<<< [^\n]*\n(\s*)"version": "[^"]*",\n=======\n\s*"version": "[^"]*",\n>>>>>>> [^\n]*\n/$1"version": "$new",\n/mg;
      open $h, ">", $f or die; print $h $s; close $h; }' \
    "$VERSION" package-lock.json package.json packages/*/package.json
  for f in package-lock.json package.json packages/*/package.json; do
    grep -q '^<<<<<<<' "$f" || git add "$f"
  done
  left="$(git diff --name-only --diff-filter=U)"
  if [ -n "$left" ]; then
    echo "== Real conflicts to resolve by hand in $WT (keep our 'dallen fork' edits):"
    echo "$left" | sed 's/^/  /'
    echo "Then: git add <files>, git commit, and rerun the checks: npm run verify-fork"
    exit 2
  fi
fi
# Set every package version (a clean merge keeps ours, which may be stale).
node -e '
  const fs = require("fs"), v = process.argv[1];
  const files = ["package.json", ...fs.readdirSync("packages").map((p) => `packages/${p}/package.json`)];
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(f, "utf8")); j.version = v;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    const key = f === "package.json" ? "" : f.replace(/\/package\.json$/, "");
    if (lock.packages[key]) lock.packages[key].version = v;
  }
  lock.version = v;
  fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
' "$VERSION"
git add package.json package-lock.json packages/*/package.json
git commit -q -m "merge: upstream $REF into $BASE_BRANCH ($VERSION)"
echo "== Merged. Verifying."
exec npm run verify-fork
