# ADR-0010: Each command reads the options file

Status: Accepted

## Decision

`main` in `src/cli.ts` reads the options file to check it, and each command that needs the options file reads it again. A deepening pass does not read it one time in `main` and give it to each command.

## Why

The scouts of #66 rated it (C15) Speculative, and that pass kept only Strong candidates and candidates worth exploring (#66, Out of scope, D3). The refuter found that the tests get less from it than the spec said: the contract tests run through `main`, so most `config.json` writes in the tests stay. The change also needs `run` wrappers in `test/create.test.ts` and `test/remove.test.ts`, which are near `max-lines` (C15 spec §2, §3).

## Reopen when

- The options file changes while a command runs, and a user sees the effect: for example, `create` makes the worktree and the tab, and then fails with `config_invalid`.
- The two test files get space below `max-lines`.
