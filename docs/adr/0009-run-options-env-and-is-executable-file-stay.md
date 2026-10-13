# ADR-0009: RunOptions.env and the isExecutableFile export stay

Status: Accepted

## Decision

`RunOptions` in `src/proc.ts` keeps its `env` field, and `src/omp.ts` keeps `isExecutableFile` as an export.

## Why

The scouts of #80 rated their deletion (C8) Speculative, and that pass kept only Strong candidates and candidates worth exploring (#80, Out of scope, D3). The two have tests: `test/proc.test.ts` gives `env` to `run` and to `must`, and `test/omp.test.ts` checks `isExecutableFile` with a table of a runnable file, a link, a plain file, a folder and a missing path.

## Reopen when

- A change to `proc.ts` or `omp.ts` touches these symbols for a different cause.
- A scout rates the deletion Strong, and a refuter makes sure that it is correct.
