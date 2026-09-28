#!/usr/bin/env bash
# Worker <-> backend version-skew check.
#
# RUN MANUALLY before any deploy where the source-direction worker (Render
# cron, rootDir ctm-core) and the backend (Render web service) can be at
# different versions -- they redeploy independently, so after a push either
# one can be live against the other for a while. NOT part of the default
# test suites (backend jest only collects backend/, and nothing here is
# named for pytest).
#
#   scripts/compat/check-worker-backend-compat.sh [OLD_REF]
#
# OLD_REF (default origin/main) is what's live now; the working tree is
# what's about to deploy. Checks both skew directions with each version's
# REAL code -- the old worker against the new backend's real routes, and
# the new worker against the old backend's -- with only Mongo and HTTP
# mocked:
#   - the worker never crashes on the other side's spike-check response
#   - every ingest and run-record POST it makes gets 201
#   - the ingest path is actually reached in each direction
#
# Needs: git, node/npm (runs `npm ci` in a temporary worktree of OLD_REF,
# so each backend version gets its own dependencies), and a Python with
# ctm-core's requirements (+ requests_mock); override with PYTHON=...
set -euo pipefail

OLD_REF="${1:-origin/main}"
ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/scripts/compat"
PY="${PYTHON:-$(command -v python3 >/dev/null 2>&1 && python3 -c 'import requests_mock' 2>/dev/null && echo python3 || echo python)}"
WORK="$(mktemp -d)"
OLD="$WORK/old"
TEST=tests/__compat__.test.js

cleanup() {
  rm -f "$ROOT/backend/$TEST"
  git -C "$ROOT" worktree remove --force "$OLD" >/dev/null 2>&1 || true
  git -C "$ROOT" worktree prune
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "old = $OLD_REF ($(git -C "$ROOT" rev-parse --short "$OLD_REF")), new = working tree"
git -C "$ROOT" worktree add -q --detach "$OLD" "$OLD_REF"
echo "installing old backend's dependencies..."
(cd "$OLD/backend" && npm ci --no-audit --no-fund --loglevel=error >/dev/null)

backend_dir() { [ "$1" = old ] && echo "$OLD/backend" || echo "$ROOT/backend"; }
worker_dir()  { [ "$1" = old ] && echo "$OLD/ctm-core" || echo "$ROOT/ctm-core"; }

# $1 = backend (old|new), $2 = mode, $3 = in, $4 = out
backend() {
  local dir; dir="$(backend_dir "$1")"
  cp "$HERE/backend_compat.test.js" "$dir/$TEST"
  if ! (cd "$dir" && COMPAT_MODE="$2" COMPAT_IN="$3" COMPAT_OUT="$4" npx jest "$TEST" >"$WORK/jest.log" 2>&1); then
    cat "$WORK/jest.log"; exit 1
  fi
  rm -f "$dir/$TEST"
}

ok=1
for pair in "old new" "new old"; do
  set -- $pair; w=$1; b=$2
  backend "$b" respond "" "$WORK/resp_$b.json"
  "$PY" "$HERE/worker_compat.py" run "$(worker_dir "$w")" "$WORK/resp_$b.json" "$WORK/cap_${w}_$b.json"
  backend "$b" accept "$WORK/cap_${w}_$b.json" "$WORK/acc_${w}_$b.json"
  "$PY" "$HERE/worker_compat.py" verify "$w worker x $b backend" "$WORK/cap_${w}_$b.json" "$WORK/acc_${w}_$b.json" || ok=0
done

[ "$ok" = 1 ] && echo "COMPAT OK" || { echo "COMPAT FAILED"; exit 1; }
