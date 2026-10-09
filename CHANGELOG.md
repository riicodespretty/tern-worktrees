# Changelog

## [0.1.0](https://github.com/riicodespretty/tern-worktrees/releases/tag/0.1.0 "2026-10-10")

### Feature

- Add the `tern-worktrees` Tern plugin in `plugin.toml`, `window.luau` and `host.luau`. `cmd+shift+w` opens the branch picker of the current repository. The branch or pull request that you pick opens as a worktree tab in the session of its repository
- Add the `tern-wt` CLI in `src/` with the commands `create`, `remove`, `list`, `branches`, `resolve`, `repos`, `clone`, `new-repo` and `setup`. Each command prints one JSON object, and each failure exits 1 with an error code
- Add the `tern-worktrees` omp skill in `skills/tern-worktrees/SKILL.md`, the CLI reference that agents follow
- Give Carly the plugin exports `create`, `list` and `remove`, which run the CLI commands of the same names
- Show a worktree row for each branch and each open pull request in the `Worktrees` group of the command palette
- Refresh the worktree rows from local refs when a pane gets focus, when a shell command ends and after a create or remove, and fetch `origin` at most one time in each `git.auto_fetch_minutes` interval
- Add `branches --offline`, which reads only local refs
- Add `Other repo…` to select a different repository: a repository of an open session, a GitHub repository, or a new GitHub repository. `tern-wt` clones a GitHub repository to the clone root
- Offer Relocate when the worktree of the branch is not in the worktree root. When git refuses the move, make the worktree again in the root. Do this only when the first worktree has no work to lose
- Offer Keep worktree (Enter), Tear down (`⌫`) and Cancel (Escape) when you close a worktree tab, and Retry, Force delete (`⌘⌫`) and Cancel when the teardown fails
- Apply the teardown policy of the options file to the branch: `worktree`, `worktree+merged-branch` (the default) or `worktree+branch`
- Read the options file `config.json` with the keys `teardown`, `cloneRoot` and `hotkeys.new`, and fail each command with `config_invalid` for an incorrect file
- Share the omp worktree root when omp is on `PATH` and `TERN_WT_HOME` is not set, and make new worktrees with `omp worktree add` when the omp setting `worktree.clone` is true
- Open an omp-owned worktree where it is, and reuse the `pr-<n>` checkout of omp for `create --pr <n>`
- Link the plugin, the CLI and the skill with `tern-wt setup`

### Enhancement

- Open each dialog where the command palette opens, with the look, the keys and the theme of the palette
- Bring back a parked worktree pane (Tern 0.6 or a newer version) as a tab with the name of the branch, in the session of its repository. Make that session when none is open
- List at most 10 files in the Teardown failed dialog, and put the hard-to-rebuild files first
- Name the worktree in the toasts of a create and a teardown, and give the outcome of the branch first in the warnings

### Fix

- Stop `remove` and Relocate from deleting submodule commits that no remote holds and hidden files
- Stop a teardown on an ignored file that is hard to rebuild, for example `.env` or `*.pem`. Copy these files into a worktree that Relocate makes again
- Validate the repository slugs and the clone root, and check all the links before `setup` changes one of them
- Close worktree tabs through the guarded close of Tern
- Drop only the stale record of the branch in `create`, not each stale worktree
- List the local branches that are not on `origin` adjacent to the `origin` branches
- Open one picker at a time, and close the stale dialog panes after a reload of the window half
- Fail with `omp_failed` when omp is on disk but `omp config list --json` fails, and do not use a different worktree root

### Config

- Build the CLI on the Vite+ toolchain with Bun 1.4.2, Oxlint and Oxfmt. Check the Luau files with StyLua and `luau-lsp`
- Gate CI on 100% test coverage and a 100% Stryker mutation score, and run the mutation tests apart from the real home folder and Tern
- Run `vp run smoke` against a Tern daemon of its own
- Lint the prose with vale and the Simplify ASD-STE100 rules
- Publish `docs/` to the GitHub wiki, and bring wiki edits back into `docs/` as a pull request
- Release with git flow from the settings in `.gitflow`

### Docs

- Document the install, the usage, the options file, omp and the CLI in `README.md`
- Document the design in `docs/README.md` and the terms in `docs/GLOSSARY.md`, and add the agent docs in `docs/agents/`
- Add the coding standards in `CODING_STANDARDS.md`
