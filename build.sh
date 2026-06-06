#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Installing build dependencies..."
pip install -r requirements-build.txt

echo "==> Building bunnydsp binary..."
pyinstaller \
    --onefile \
    --name bunnydsp \
    --add-data "templates:templates" \
    --add-data "static:static" \
    --exclude-module PyQt5 \
    --exclude-module PyQt6 \
    --exclude-module PySide6 \
    --clean \
    app.py

echo "==> Done. Binary at dist/bunnydsp"
echo "    Run:          ./dist/bunnydsp          (native window)"
echo "    Run (browser): ./dist/bunnydsp --web    (opens browser)"
