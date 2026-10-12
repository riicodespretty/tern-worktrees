#!/bin/sh
set -eu

ls *.luau >/dev/null 2>&1 || exit 0

luau-lsp analyze --platform=standard --definitions=@tern=types/tern.d.luau *.luau
