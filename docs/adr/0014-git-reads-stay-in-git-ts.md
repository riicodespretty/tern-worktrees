# ADR-0014: The git reads of work to lose stay in git.ts

Status: Accepted

## Decision

`ignoredFiles`, `unpushedCommits` and `submodules` stay in `src/git.ts`. `src/work-to-lose.ts` holds the rules of work to lose and calls them. A deepening pass does not move them into `work-to-lose.ts`.

## Why

The move fails the deletion test, and it forces the private `lines` helper of `git.ts` out of that module (#66, Out of scope, C14 spec).

## Reopen when

`work-to-lose.ts` becomes the only caller of each of the three functions, and `lines` has no other caller in `git.ts`.
