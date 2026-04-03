#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="${HOME}/.local/bin"
TARGET_PATH="${TARGET_DIR}/mectov"

mkdir -p "$TARGET_DIR"
ln -sfn "$REPO_DIR/mectov" "$TARGET_PATH"

echo "Installed: $TARGET_PATH -> $REPO_DIR/mectov"
echo
echo "If ~/.local/bin is not in your PATH yet, add this to ~/.bashrc:"
echo 'export PATH="$HOME/.local/bin:$PATH"'
