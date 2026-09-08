#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."

if command -v python3 >/dev/null 2>&1; then
    PYTHON=python3
elif command -v python >/dev/null 2>&1; then
    PYTHON=python
else
    PYTHON=py
fi

echo "=== Running full test suite ==="
"$PYTHON" -m pytest tests/ -v
status=$?

echo ""
echo "=== Summary ==="
"$PYTHON" -m pytest tests/ -q | tail -5

# pytest exit code 5 means "no tests collected", which is expected on a
# fresh scaffold and shouldn't be treated as a failure.
if [ "$status" -ne 0 ] && [ "$status" -ne 5 ]; then
    exit "$status"
fi
