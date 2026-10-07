# Coding standards

Review reads this file. Each rule here is a judgment call that no linter makes. The lint, format and test gates in `AGENTS.md` cover the mechanical rules.

## One implementation

- The CLI in `src/` is the one implementation of each git, gh and path rule. `window.luau` and `host.luau` call the CLI for paths, defaults and checks. A Luau copy of a CLI rule (the worktree root, the defaults of the options file, a path test) is a defect, because the two copies drift.
- A command module in `src/commands/` exports `run` only. A helper that two commands share goes in `src/git.ts`, `src/paths.ts` or a small module adjacent to them.

## Contracts that meet

- A list command shows each value that its action command accepts. For example, each branch that `create --branch` accepts is in the output of `branches`. Also check the second visit of the user: the branch from the last run, or the worktree kept after a teardown.
- A change to the arguments, output, error codes or order of steps of a command updates `skills/tern-worktrees/SKILL.md` and `README.md` in the same commit. Each claim in those files and in `docs/` agrees with the code. Read the code line before you write the claim.
- Prose uses the terms in `docs/GLOSSARY.md`. A term on an `_Avoid_` line is a defect in docs, in doc comments and in the skill. An identifier that a contract fixes, for example `config_invalid`, keeps its name.

## Tests that guard

- A guard that stops a side effect has a test that proves the side effect does not run on bad input. Inject the seam, record the calls, and assert that it records none. A test that passes only because a subsequent step fails for a different cause does not count.
- Each machine location that the code reads (a home path, an environment variable, the Tern socket, the plugin data folder) has a test override in `test/helpers.ts`, and the `test.mutation` script in `package.json` points it at a temp folder. A new location adds the two in the same commit, so no test and no mutant writes to the real machine.
