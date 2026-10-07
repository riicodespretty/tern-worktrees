#!/bin/sh
set -eu

ls *.luau >/dev/null 2>&1 || exit 0

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

defs=types/tern.d.luau
pattern='): userdata$'
patched="$tmp/tern.d.luau"

if ! grep -q "$pattern" "$defs"; then
  echo "check-luau: no line matching '$pattern' in $defs; the Tern types patch would change nothing" >&2
  exit 1
fi

sed "s/$pattern/): any/" "$defs" > "$patched"

luau-lsp analyze --platform=standard --definitions=@tern="$patched" *.luau
