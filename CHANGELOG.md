# Changelog

## Unreleased

### Feature

- Add `clean --repo <dir> [--apply]` with a read-only dry-run plan, causes for keeping resources and warnings. Tell agents to show the plan and get explicit approval before `--apply`, which fetches and prunes `origin` before building a new plan. Preserve the caller and live sessions, and resources without proof of ownership or safety. Prove branch integration through ancestry of `origin/<default>` or one merged pull request's head commit, or through `git merge-tree` when the default branch's tree stays unchanged. Without the closed-link exception below, preserve work to lose and branches without proof of integration. Scope Docker removal to attributable containers. Keep shared services and anonymous volumes, with no host-wide Docker or temporary-file sweep
- Remove worktrees and branches linked to closed issues or closed or merged pull requests. Resolve links through branch names, `ternIssue`, `pr-<number>` or numbered worktree folders. Show the cause and recovery requirement in the plan. Set `recovery: true` on each `removalDetails` entry, also for integrated branches with commits missing from remote branches. Before removal, save patches, files not tracked by Git, branch tips and local-only commits. Save recovery files for initialized submodules too. Keep live resources, unknown or open links and hard-to-rebuild ignored files
- Bound concurrent branch and worktree inspections in `clean`, batch branch tips and ancestry proofs, and avoid `merge-tree` for branches proven integrated. Read linked issue states and merged pull request heads in one batched GitHub operation
- Add optional `.tern/worktree.json` declarations for repository setup commands, shared Docker services, literal environment variables and `heavy.slotMemoryGb`. Add `prepare <path> [--no-setup]` to start services and run repository setup before user setup. Add `env <path> [--shell]` to return the environment as JSON or POSIX-quoted exports
- Add `heavy [--repo <dir>] -- <command>` with host-wide memory-sized slots, stale-PID lock recovery, signal cleanup and child output and exit-code passthrough. Add `heavy --status` for slot ownership and host memory
- Prepare services before opening a new worktree tab. Prefix its setup line with `eval "$(tern-wt env . --shell)"` when environment variables are declared. Run repository setup before user setup. Keep `--no-tab` free of service and tab side effects while returning the setup line. Add `worktree_config_invalid`, `setup_failed`, `service_failed` and `docker_missing` errors
- Add `create --issue <url|#n>` to derive or reuse an issue branch, record `branch.<branch>.ternIssue`, and open its worktree tab. Support `--branch` overrides, read-only `--suggest`, pull request URLs and `not_cloned` with the clone path. Add `issueBranch.fixLabels` and opt-in `issueBranch.linkOnGitHub` for remote branch creation with `gh issue develop`. Tell agents to use `--issue` for issue work and `Closes <owner>/<repo>#<n>` in PR bodies. Before, agents invented branch names and recorded issue links by hand
- Add `From issue…` to the branch picker and `New worktree from issue` to the palette, with the command `plugin.tern-worktrees.from-issue`. Pre-fill an issue prompt from the clipboard, let the user edit the derived branch name, and detect issue URLs in `New branch…`. Use a matching open repository session or offer to clone the repository. Before, users had to select a repository and invent the branch name to start from an issue

### Fix

- Find Bun through mise's shims when Tern starts with a GUI PATH. Previously the window's automatic setup failed with `bun not found` even though Bun worked in terminal login shells.
- Link the bundled skill at `~/.agents/skills/tern-worktrees` for cross-agent discovery. Remove the previous omp link only when it points into a `tern-worktrees` package, and report that removal in setup output. Preserve real folders and unrelated links
- Expand `~` and `~/` in CLI directory arguments while keeping each `resolve` lookup key as given. Compare home-relative pane directories with absolute worktree index paths. Before, an agent directory that starts with `~/` resolved to no repository and selected the session's first repository
- Defer worktree index and hotkey file reads until after window load. Coalesce directory, focus and command end refreshes on the next tick. Register worktree rows in batches of eight. Look up status entries through directory parents without a full worktree scan
- Select the repository of an agent when the pane with the focus has no working directory. Without an agent directory, use the first known directory in its tab. Apply this rule to the branch picker, worktree rows and the issue palette command. Before, an omp chat pane could select the first repository of a different tab
- Examine process working directories on macOS with `lsof` and parent relationships with `ps` for `clean`. Use the Linux protection rules for the caller, live sessions and shared infrastructure. Keep worktrees with an explicit cause when `lsof` is unavailable or fails. Before, all macOS worktrees stayed because process inspection required Linux `/proc`
- Limit process inspection that is not full in `clean` to worktrees containing the process's known working directory. Identify process-related keep causes by PID and command, or state that inspection is unavailable. Before, one process that could not be examined kept all worktrees. Keep worktrees when process or Tern inspection is unavailable. Branch cleanup can still continue
- Treat ignored Python tool caches, virtual environments and TypeScript build info as output that tools make again. Before, `.pytest_cache`, `.ruff_cache`, `.mypy_cache`, `__pycache__`, `.venv` and `*.tsbuildinfo` stopped worktree removal without `--force`, and Relocate copied them into the worktree it made again
- Open the branch picker for the repository of the pane with the focus. This applies to the hotkey and the worktree segment. Before, the picker opened for the first repository of the session, so `New branch…` could make a worktree in the incorrect repository
- Let a clean worktree go when its submodule release history is recorded in the main checkout. Before, a detached submodule at a release tag not held by remote branches gave `dirty_worktree`. The check stays local and still stops on a submodule commit recorded only in the worktree
- Refuse `tern-wt remove` with `busy_tabs` before removing a worktree whose blocks run foreground processes. Use `--close-busy-tabs` to close them after the user agrees. Before, `--force` could stop an agent session without a warning

## [0.3.2](https://github.com/riicodespretty/tern-worktrees/releases/tag/0.3.2 "2026-10-14")

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
