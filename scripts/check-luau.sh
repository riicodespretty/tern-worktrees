#!/bin/sh
set -eu

ls *.luau >/dev/null 2>&1 || exit 0

luau-lsp analyze --platform=standard --definitions=@tern=types/tern.d.luau *.luau

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && HOME="$tmp" lune setup >/dev/null)
sed "s#~/#$tmp/#" "$tmp/.luaurc" > "$tmp/lune.luaurc"
luau-lsp analyze --platform=standard --base-luaurc="$tmp/lune.luaurc" test/luau/*.luau
