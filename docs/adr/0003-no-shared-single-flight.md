# ADR-0003: No shared single-flight interface for list and branches

Status: Accepted

## Decision

In `window.luau`, the `list --all` runs of the worktree index and the `branches` runs of the branch picker cache each keep their own rule for one run at a time. A deepening pass does not put the two behind one single-flight interface.

## Why

Only the timeout check of a run is the same in the two (#54, Out of scope, C1 spec §4.4). The other rules are different. A `branches` request during a run queues one more run, and that run is online when one of the requests is online. A `list --all` refresh starts at most one run in each 2 s, and a timer runs a request from that gap one time. docs/README.md gives the two rules in the sections The branch picker cache and The worktree index. A shared interface that holds only the timeout check is shallow.

## Reopen when

- A third CLI call needs one run at a time.
- The queue rules of `list --all` and `branches` become the same.
