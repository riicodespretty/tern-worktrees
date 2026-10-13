# Changelog

## Unreleased

### Fix

- Learn the worktree root from each `tern-wt list --all` answer in the Tern window. Before, the first answer could fail, or the plugin could drop it. Then a new worktree in the root did not refresh the worktree index until the next window start
- Pass a branch to `create` as one `--branch=<name>` argument from the worktree rows and the Carly `create` export, as the branch picker does. Before, a branch name that starts with `-` gave a parse error, not `bad branch name`
- Show `tern-wt failed` when a `tern-wt` run fails with no error envelope and no standard error output. Before, the error toast and the Carly error had an empty message
- Reuse the clone in the clone root when its `origin` names the same GitHub repository with different uppercase and lowercase letters. Before, a second `tern-wt clone OCTOCAT/hello-world` gave `path_conflict`, because `gh repo clone` writes the letters that GitHub uses into `origin`. `repos` then also gives the clone as `local` when the letters of its `origin` are not the letters of GitHub

## [0.3.1](https://github.com/riicodespretty/tern-worktrees/releases/tag/0.3.1 "2026-10-13")

### Feature

- Add `warnings` to the output of `list`. It names each worktree whose changes git could not count, with the git error

### Fix

- Open a new worktree tab in the session that has a pane in the main checkout of the repository. Without such a session, use the session with the name of the repository. Without that session, use a session with a pane in the repository. Before, the first pane of each session gave its repository. Thus a session whose first tab was in a linked worktree got the tab
- In omp clone mode, fix the submodules that the clone copied. Before, the copied `.git` file of each submodule pointed to no git folder, so `git status` failed in the worktree. `create` copies the submodule git folders of the main checkout into the git folder of the worktree. It then deletes the broken `.git` files and runs `git submodule update`. Each submodule is then at the recorded commit, and the files of the clone stay. When the copy fails, `create` gives a `submodule repair failed:` warning and keeps the worktree
- Do not fail `list` when git cannot count the changes of one worktree, for example because of a broken submodule `.git` file. That worktree stays in the output with the count without its submodules, or 0. Before, one broken worktree failed `list --all`, and the worktree index of the window stopped its updates

## [0.3.0](https://github.com/riicodespretty/tern-worktrees/releases/tag/0.3.0 "2026-10-13")

### Feature

- Make `tern plugin install github.com/riicodespretty/tern-worktrees` the one install route. Each time the plugin loads in a Tern window, also after an install into an open window, it runs `tern-wt setup`, which links `~/.local/bin/tern-wt` and the omp skill to the installed copy of the plugin. A `Linked tern-wt and the tern-worktrees skill` toast shows when a link changes, and a `Setup failed: …` toast shows when `setup` fails
- Stop linking the Tern plugin in `tern-wt setup`. Its output has no `plugin` field, and a copied install of the plugin no longer gives `path_conflict`
- Give `kept`, not `path_conflict`, when a second `tern-wt setup` that runs at the same time makes the same link first
- Open the main checkout when the picked branch or the head branch of `--pr` is checked out there. Before, `create` failed with `branch_in_main_checkout`, which is gone. `create` gives `owner: "main"` and the status `reused`, and `--relocate` does not move the main checkout. The plugin focuses or opens its tab with an `Opening main checkout…` toast, then an `Opened main checkout` toast. It writes no worktree index entry for it, so its close opens no teardown picker

### Fix

- Show the `Deleting worktree <branch>…` toast for Tear down and Retry, not only for Force delete

## [0.2.0](https://github.com/riicodespretty/tern-worktrees/releases/tag/0.2.0 "2026-10-13")

### Feature

- Add `tern-wt config`, which prints the options file with each default filled in
- Add `owner`, `tern` or `omp`, to the output of `create`
- Add `changes` and `hardToRebuild` to the `dirty_worktree` error of `remove` and Relocate. `files` stays the same
- Add `prsFailed` to the output of `branches`. It is true when `gh pr list` failed
- Add `branchKept` to the output of `remove`: `policy`, `not_merged` or `not_deleted` when `remove` kept the branch, else null
- Add `repo`, the main checkout of the removed worktree, to the output of `remove`
- Show and update the pull request rows after each open of the branch picker, also with `git.auto_fetch_minutes` 0

### Fix

- Read the teardown policy of the close-tab picker from `tern-wt config`. An invalid options file gives no detail line, not a policy that the CLI rejects
- Get the worktree root only from the CLI in the Tern window. With omp installed, the window no longer uses `~/.tern-wt/worktrees` before the first `tern-wt list --all` answers
- Count a tab that `tern-wt create` opened from a shell as a worktree tab after one refresh. Its close then offers the teardown picker
- Run one `branches` at a time for each repository, which the worktree rows and the branch picker share. A create or a teardown refreshes only the repository of its worktree
- Start a new `branches` or `list --all` when Tern dropped the answer of the last one for 120 s. Before, the worktree rows and the worktree index stopped their refreshes until the plugin reloaded
- Open a new worktree tab in the oldest session of its repository when two or more sessions show that repository. Before, the order of a Luau table selected the session
- Show no `worktree` text for the branch of the main checkout, in the branch picker and on its worktree row. Each entry of `worktrees` in the `branches` output has `main`, which is true for the main checkout
- Run `resolve` again when `create` answers, as the Carly `create` export did. This applies to a create from the branch picker, a worktree row, Relocate and New branch. Thus a repository session that opened after the window started gets the tab, and no second session opens for that repository. When the tab step raises, the plugin still refreshes the worktree rows and shows the `Created worktree` or `Reused worktree` toast with `tab not opened: <error>`. The `Setup not run: …` toast shows after the success toast, so the success toast no longer replaces it
- Open no tab when the new tab of a new or empty session is missing. Before, the plugin tried a switch, a parked-pane move and one more tab
- Give no `staging` in the Relocate error when the staging step fails and the second lock also fails. Before, that error named the staging folder

### Config

- Run the mutation tests in CI only for a push to `main` and for a pull request into `main`

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
