# ADR-0013: Two fields and one key, not a boolean, for repository relations

Status: Accepted

## Decision

- The create `Target` in `src/commands/create.ts` keeps the two fields `forkPr` and `ompPrBranch`. It does not get one `fork: boolean`.
- `src/repo-ref.ts` keeps one exported `repoKey` for the same GitHub repository. It does not get a boolean `sameRepo(a, b)`.

## Why

- With `fork: boolean` and `pr: string | null`, the types let `fork: true` with no pull request through. The code that makes `pr-<n>` from it adds equivalent Stryker mutants, and the gate is a score of 100 with no `Stryker disable` comments (#66, Out of scope, C10 spec §2).
- In a `sameRepo(a, b)`, Stryker's `toLowerCase` to `toUpperCase` mutant survives. `repoKey` is the map key of the setup commands and the key that `clonePath` compares (#95, Out of scope, C4 spec).

## Reopen when

Stryker can kill each mutant of the boolean form, or the gate accepts a lower score.
