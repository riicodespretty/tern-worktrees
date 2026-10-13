# ADR-0007: Each command keeps its own catch of a CLI error as a warning

Status: Accepted

## Decision

`remove` keeps its local `warnOnCliError` in `src/commands/remove.ts`, and `create` keeps `tryOpenTab` in `src/commands/create.ts`. A deepening pass does not move one shared `warnOnCliError` into `src/proc.ts`.

## Why

The scouts of #80 rated the shared helper (C11) Speculative, and that pass kept only Strong candidates and candidates worth exploring (#80, Out of scope, D3). `create` has one catch of this shape, so the shared helper gets only one more caller. The catch in `create` gives `null`, and its warning has the fixed label `tab not opened`.

## Reopen when

- A third command turns a CLI error into a `warnings` entry.
- `create` gets a second catch of this shape.
