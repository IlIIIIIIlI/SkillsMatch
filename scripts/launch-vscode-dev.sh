#!/usr/bin/env bash
set -euo pipefail

workspace_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vscode_bin="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
user_data_dir="$workspace_dir/.vscode-dev/user-data"
extensions_dir="$workspace_dir/.vscode-dev/extensions"

if [[ ! -x "$vscode_bin" ]]; then
  echo "Visual Studio Code CLI was not found at $vscode_bin."
  exit 1
fi

mkdir -p "$user_data_dir" "$extensions_dir"

"$vscode_bin" \
  --new-window \
  --user-data-dir "$user_data_dir" \
  --extensions-dir "$extensions_dir" \
  --extensionDevelopmentPath "$workspace_dir" \
  "$workspace_dir"
