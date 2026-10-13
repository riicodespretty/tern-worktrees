# ADR-0004: The rules for the repository of a directory stay apart

Status: Accepted

## Decision

The code that finds the repository of a directory keeps its rules apart:

- In `window.luau`, `resolve_sessions` and `refresh_dir` each run `tern-wt resolve`, but the two do not share a cache or a skip of a running call. `seen` and `resolving` stay two rules.
- `rootOfDir` can keep a cached `false` until `resolve_sessions` writes the entry again.
- The update of the map of worktree tabs after a `list --all` answer requests no `list --all`. Only the events that docs/README.md lists in the section The worktree index request it.
- In `src/git.ts`, `repoRoot` and `checkoutAt` stay two functions.

## Why

- `resolve_sessions` must run on each call, also when each directory is in the cache, and it must call its callback also on an error. A cache or a skip in front of it breaks the five `resolve` cases of `opened.test.luau`. `seen` removes duplicate directories from the arguments of one call. `resolving` skips a second call while one runs (#66, Out of scope, C2 spec).
- Only the worktree rows read the stale `false`, and only until the next press of the hotkey (#54, Out of scope, C4 spec claim 8).
- A pane in `<root>/<repo>` is not in a worktree. When the map update requests `list --all`, that pane starts a new `list --all` each 2 s (C5 spec of #54, docs/README.md "Close interception").
- `repoRoot` needs no real path on disk and has five callers. `checkoutAt` compares real paths for the rule "the top folder of a checkout" (#80, sweep judgement 2, accepted as is).

## Reopen when

- `resolve_sessions` no longer needs a new answer on each call.
- Each caller of `repoRoot` can give a directory that is on disk.
