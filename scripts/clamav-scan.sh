#!/usr/bin/env bash
set -euo pipefail

if ! command -v clamscan >/dev/null 2>&1; then
  echo "clamscan is not installed."
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "This script expects to run inside a git repository."
  exit 1
fi

file_list="$(mktemp)"
trap 'rm -f "$file_list"' EXIT

git -c core.quotepath=false ls-files > "$file_list"

if [[ ! -s "$file_list" ]]; then
  echo "No tracked files to scan."
  exit 0
fi

clamscan --infected --no-summary --file-list="$file_list"
