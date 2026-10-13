# ADR-0001: Relocation, tab opening and setup typing stay in create.ts

Status: Accepted

## Decision

`src/commands/create.ts` keeps the relocation steps, the tab opening (`openTab`, `tryOpenTab`) and the setup typing. A deepening pass does not move them into a new module, for example `src/relocate.ts`.

## Why

Relocation has one caller, `create`, and a new module gives no new test seam (#54, Out of scope, C7 spec §1). The scout of #54 found no problem in the tab opening and the setup typing (C7 spec H6). A move only adds an import and an export.

## Reopen when

- `create.ts` goes above `max-lines`. The limit is 500 lines without comments (`oxlint.config.ts`, `eslint/max-lines`). At e2e593c the file has 489 lines with comments.
- A second command starts a relocation.
