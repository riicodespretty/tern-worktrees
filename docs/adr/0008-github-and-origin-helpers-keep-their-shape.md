# ADR-0008: The gh and origin helpers keep their shape

Status: Accepted

## Decision

- `src/github.ts` keeps `ghMustWith` and `ghMust`, also after `gitMustWith` went from `src/git.ts`.
- `readOrigin` stays in `src/github.ts`, and `fetchOrigin` stays in `src/git.ts`.
- `readOrigin` keeps `git remote get-url origin`. It does not change to `git config --get`.
- `parseGithubUrl` and `parseRepoRef` in `src/repo-ref.ts` share no helper.

## Why

- gh has no `-C` flag, so its one caller, `create.ts` (`gh pr checkout` in the new worktree), needs the `cwd` field of `RunOptions` (#66, sweep judgement 3).
- `readOrigin` parses a GitHub URL, and `fetchOrigin` is plain git I/O. The C16 spec of #66 put them in two modules on purpose (#66, sweep judgement 4).
- `git remote get-url` expands `url.<base>.insteadOf`, and `git config --get` does not. The users keep that expansion (#66, D4).
- The two parsers share one line, and only their patterns are different, so a helper is shallower than the code that it replaces (#80, sweep judgement 3).

## Reopen when

- gh gets a `-C` flag, or `ghMustWith` gets no caller.
- A third command reads and fetches `origin`.
- A third parser in `repo-ref.ts` makes the same `{ name, owner }` value.
