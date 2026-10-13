# ADR-0002: No shared Luau module for the host and the window

Status: Accepted

## Decision

`host.luau` and `window.luau` each keep their own copy of a rule that the two need, for example the worktree index lookup. The window also keeps its copy of the `hotkeys.new` default. A test guards each copy.

## Why

Tern 0.8.0 gives plugins no `require`, and the host and the window run in isolated virtual machines. Thus a shared module is not possible (#54, Out of scope, C5 spec §3). The window reads `hotkeys.new` when it loads, so it cannot wait for an answer of the CLI (#54, C5 spec §2). The T1 case table of #55 guards the index lookup copy, and a drift test guards the `hotkeys.new` copy. New Luau code is a local section of the file that it serves, not a new module file.

## Reopen when

- Tern gives plugins `require`, or a different way to share code between the host and the window.
- The window can read the hotkey default from the CLI before it registers the hotkey.
