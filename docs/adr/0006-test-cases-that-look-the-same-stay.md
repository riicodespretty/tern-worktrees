# ADR-0006: Test cases that look the same stay where they are

Status: Accepted

## Decision

A deepening pass does not merge, move or delete these test cases:

- The two teardown tests in `window.test.luau`, for the Carly `remove` export and for the close-tab picker.
- The submodule copy case in `test/remove.test.ts`.
- The symbolic-link case in `test/remove-omp.test.ts`.

It also adds no direct `parseRepoRef` tests, and no `tab_closed` case after a Carly `remove`.

## Why

- Each teardown test guards a different entry of the plugin (#54, Out of scope, C3 spec claim 10).
- The case in `remove.test.ts` is the only proof that the guard of work to lose gets the main checkout (#80, C10 spec).
- The case in `remove-omp.test.ts` is the only guard of the symbolic-link rule (#95, C3 spec §2 claim 5).
- Direct `parseRepoRef` tests copy the case table of `test/repos.test.ts` (#80, C12 spec).
- `window.test.luau` guards that `tab_closed` asks nothing about a deleted folder (#80, C6 spec).

## Reopen when

A different test takes over the guard of the case. Then delete the case in the same commit, and name the new guard.
