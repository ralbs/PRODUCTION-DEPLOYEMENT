#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
echo "=== Running full test suite ==="
python3 -m pytest tests/ -v
echo ""
echo "=== Summary ==="
python3 -m pytest tests/ -q | tail -5
