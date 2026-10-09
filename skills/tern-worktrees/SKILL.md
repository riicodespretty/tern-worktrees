---
name: tern-worktrees
description: Use to create, list, relocate or tear down git worktrees as Tern tabs with tern-wt. Replaces Orca worktrees.
---

# tern-worktrees

`tern-wt` keeps git worktrees in the worktree root and opens each one in a Tern tab. The worktree root is `$TERN_WT_HOME/worktrees` when `TERN_WT_HOME` is set. Else, when omp is installed, it is omp's default worktree root, usually `~/.omp/wt`: `$OMP_WORKTREE_DIR`, else the omp setting `worktree.base`, else the `wt` folder of the omp data folder, which follows `PI_CONFIG_DIR`, `OMP_PROFILE` and `$XDG_DATA_HOME/omp` as omp does. Else it is `~/.tern-wt/worktrees`. A tern-managed worktree is at `<root>/<repo>/<slug>`, where `<repo>` is the folder name of the main checkout and the slug is the branch name with each `/` changed to `-`. Each other worktree in the omp worktree root is omp-owned: `tern-wt` opens it, and does not remove it.

## Rules

- Use `tern-wt` for worktrees, not `git worktree` or `orca worktree`.
- Run `remove` only on a worktree you created in this session, or one the user names.
- Pass `remove --force` only after the user says yes: it discards uncommitted work.
- Tabs that `create` opens are yours to close (skill://tern-cli). `remove` closes them.
- Do not run `omp worktree clear` without `--dry-run` first. With or without `--all`, it deletes each worktree that omp sees as orphaned, and omp can see a live tern-managed worktree as orphaned, for example with `worktree.useRelativePaths=true` or after the main checkout moved.

## Output

Each command prints one JSON object to standard output.

- Exit 0: the result. Read its `warnings`. Each warning is a problem that did not stop the command.
- Exit 1: `{"error":{"code":"<code>","message":"<text>", ...}}`, plus the message on standard error. Some codes add fields: see [Error codes](#error-codes).

When omp is on disk but `omp config list --json` fails in `/`, the worktree root is unknown: `create`, `remove`, `list` and `branches` fail with `omp_failed`. `~/.tern-wt/worktrees` is the root only when no omp binary is on disk.

## Commands

### `create`

`tern-wt create --repo <dir> (--branch <name> [--new] | --pr <number>) [--relocate] [--no-tab]`

Makes the tern-managed worktree of a branch, or reuses it. Then opens its tab, or focuses the tab that is open. When the branch has an omp-owned worktree, `create` reuses that worktree where it is, with no `--relocate`. Reuse matches by branch: omp checks out pull request `<n>` on the branch `pr-<n>`. For `--pr <n>` of a pull request from the same repository, when no worktree has its head branch, `create` reuses omp's worktree on `pr-<n>` when the git config key `branch.pr-<n>.ompPrHeadRef` is not set or names the head branch. `branch` in the output is then `pr-<n>`.

When omp is installed and the omp setting `worktree.clone` is true in the repository, `create` makes the worktree with `omp worktree add`, also when `TERN_WT_HOME` is set. A rebuilt relocation uses plain git. The new worktree starts as a copy-on-write clone of the main checkout, so it has the ignored files of the main checkout, for example `.env` and `node_modules`. A new branch gets the same upstream as plain `git worktree add -b` gives it, `origin/<default>` with the git defaults. Each line that omp prints to standard error, for example that the clone fell back to a checkout, becomes a warning that starts with `omp:`. When `omp config list --json` fails in the repository, `create` uses plain git and adds a warning that starts with `omp config list`. omp moves an invalid `.omp/config.yml` of the repository aside to `.omp/config.yml.broken-<id>` when it reads it.

- `--repo`: a dir in the repository.
- `--branch`: a local branch or a branch on `origin`. A name that git rejects gives `bad_args`.
- `--new`: make `--branch` a new branch from `origin/<default>`. When the branch is local or on `origin`, `--new` gives `bad_args`, also when the branch has a worktree.
- `--pr`: the branch of a pull request. A pull request from a fork gets the branch `pr-<number>`.
- `--relocate`: move the worktree of the branch into the worktree root from a path that is not in the root. Pass it only after the user says yes. When git refuses the move, `create` makes the worktree again in the root with plain `git worktree add`, but only when the first worktree has no work to lose: a changed file, a new file that git does not track, or a submodule commit that no remote holds. Ignored files that are hard to rebuild (see `remove`) are copied into the new worktree.
- `--no-tab`: skip the tab.

Output: `{"path", "branch", "repo", "status", "carried", "tab", "warnings"}`.

- `status`: `created`, `reused` or `relocated`. For an omp-owned worktree, `reused` with its `path`.
- `carried`: the ignored files, as paths in the worktree, that a rebuilt relocation copied into the new worktree. Empty otherwise. When the new worktree has a file at that path, the copy stays in the temporary folder, with a `not carried:` warning.
- `tab`: `{"session", "block", "opened"}`, or null with a `tab not opened:` warning. `opened` is false when `create` focused a tab that was open before.

### `remove`

`tern-wt remove <path> [--force] [--keep-tab]`

Removes the tern-managed worktree at `<path>`, closes its tabs, then applies the teardown policy to its branch. An omp-owned worktree gives `not_managed`. `--keep-tab` keeps the tabs open. A worktree with a changed file, a new file that git does not track, a submodule commit that no remote holds, or an ignored file that is hard to rebuild gives `dirty_worktree` and stays. An ignored file is build or install output when a part of its path is `node_modules`, `dist`, `build`, `coverage`, `.DS_Store`, `.cache`, `.next`, `.nuxt`, `.output` or `.turbo`. That output goes with the worktree. Each other ignored file, for example `.env`, is hard to rebuild. An ignored file with the same bytes as the file at the same path in the main checkout, or in the same submodule of the main checkout, is a copy and goes with the worktree. `--force` deletes all of them.

Output: `{"removed", "branch", "branchDeleted", "closedBlocks", "warnings"}`. `branch` is null for a detached `HEAD`. A branch that the policy keeps adds the warning `kept local branch <branch>: not merged`, and a failed delete adds `branch <branch> not deleted: <reason>`. That warning comes first in `warnings`.

### `list`

`tern-wt list [--repo <dir>]`

Output: `{"root", "worktrees": [{"path", "repo", "branch", "dirty"}], "warnings"}`. `list` shows the tern-managed worktrees only. With `--repo`, `list` shows only the worktrees of the repository that contains `<dir>`.

### `branches`

`tern-wt branches --repo <dir> [--offline]`

- `--offline`: read only local refs. It does not run `git fetch --prune origin`, does not list the open pull requests, and does not ask GitHub for the default branch. `prs` is `[]`, and `branches` has the branches on `origin` as of the last fetch. When `origin/HEAD` is unset, `default` is the current branch.

Output: `{"repo", "name", "default", "branches", "prs": [{"number", "title", "branch", "fork"}], "worktrees": [{"branch", "path", "managed", "owner"}], "warnings"}`. `owner` is `tern` for a tern-managed worktree, `omp` for an omp-owned worktree, and null for a worktree that is not in the worktree root. `managed` is true for a tern-managed worktree. `branches` is sorted by the date of the last commit on each branch, newest first. It has the local branches and the branches on `origin`, each once. When `gh pr list` fails, `prs` is `[]` and `warnings` has an entry that starts with `pr list failed:`. The Tern window uses that prefix to find a failed pull request list.

### `resolve`

`tern-wt resolve <dir>...`

Output: `{"repos": [{"dir", "root", "name", "owner"}]}`. `root`, `name` and `owner` are null for a dir that is not in a repository.

### `repos`

`tern-wt repos`

Output: `{"owners", "repos": [{"nameWithOwner", "isPrivate", "description", "local"}], "warnings"}`. `owners` is the GitHub user, then each GitHub organization of that user. `local` is the clone of the repository in the clone root. It is null when nothing is at the clone path, and also when the path holds something else, an empty folder included. In that case, `clone` gives `path_conflict`.

### `clone`

`tern-wt clone <owner/name>`. The owner starts with a letter or digit. The owner and the name use only letters, digits, `.`, `_` and `-`. The name does not start with `-`, and it is not `.` or `..`. A name with owner that breaks these rules gives `bad_args`.

Clones the GitHub repository to `<cloneRoot>/<owner>/<name>`, or reuses the clone there. Output: `{"root", "cloned"}`.

### `new-repo`

`tern-wt new-repo <owner/name> --visibility private|public`

Makes a GitHub repository with a README, then clones it. It checks the clone path first, so a `path_conflict` makes no repository. The name with owner follows the rule of `clone`. Run it only when the user asks for a new repository. Output: `{"root", "nameWithOwner"}`.

### `setup`

`tern-wt setup`

Links the Tern plugin, `~/.local/bin/tern-wt` and this skill to the checkout. A second run changes nothing. Output: `{"plugin", "links": [{"path", "target", "action"}]}`, with `plugin` `linked` or `already`, and `action` `created`, `kept` or `replaced`.

## Error codes

| Code                        | Added fields         | Next step                                                                                                                                                                            |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bad_args`                  |                      | Fix the arguments from the message.                                                                                                                                                  |
| `config_invalid`            |                      | Show the user the message, which names the file and the key.                                                                                                                         |
| `not_a_repo`                |                      | Pass a dir in a git repository.                                                                                                                                                      |
| `not_managed`               |                      | `remove` acts only on a tern-managed worktree, not on an omp-owned one. Get the paths from `list`.                                                                                   |
| `path_conflict`             | `path`               | Show the user `path`. Keep it as it is.                                                                                                                                              |
| `branch_in_main_checkout`   | `existing`           | Tell the user. The main checkout holds the branch.                                                                                                                                   |
| `worktree_exists_elsewhere` | `existing`, `target` | Ask the user, then run `create` again with `--relocate`.                                                                                                                             |
| `dirty_worktree`            | `existing`, `files`  | Show the user `files`. An entry `!! <path>` is an ignored file that is hard to rebuild. Relocate and `remove` keep a worktree with work to lose. For `remove`, ask before `--force`. |
| `git_failed`                |                      | Show the user the message. For `remove`, ask before `--force`.                                                                                                                       |
| `gh_failed`                 |                      | Show the user the message. Check `gh auth status`.                                                                                                                                   |
| `omp_failed`                |                      | Show the user the message. omp is installed but `omp config list --json` failed, so the worktree root is unknown. Fix omp, then run the command again.                               |
| `tern_failed`               |                      | Show the user the message. Check that Tern runs.                                                                                                                                     |

An error from `create` after a rebuilt relocation copied the ignored files adds the field `staging`: the temporary folder that keeps those copies. The message names it. Tell the user, and do not delete that folder.

## Options file

The file is `config.json` in the plugin data dir, the first of:

1. `$TERN_PLUGIN_DATA`, when set.
2. `$TERN_CONFIG_DIR/plugin-data/tern-worktrees`, when `TERN_CONFIG_DIR` is set.
3. `~/Library/Application Support/Tern/plugin-data/tern-worktrees` on macOS, and `${XDG_STATE_HOME:-~/.local/state}/tern/plugin-data/tern-worktrees` on other systems.

An invalid file makes each command fail with `config_invalid`. The keys:

- `teardown`: the teardown policy. It sets what `remove`, and the close of a worktree tab, do to the branch. `worktree` keeps the branch. `worktree+merged-branch`, the default, deletes a merged branch. `worktree+branch` deletes the branch. A branch is merged when it is an ancestor of `origin/<default>`, or when its tip is the head commit of a merged pull request or an ancestor of that commit.
- `cloneRoot`: the dir for `clone` and `new-repo`, an absolute path or a path that starts with `~`. The default is `~/Developer`.
- `hotkeys.new`: the Tern key chords that open the picker for a new worktree tab. The default is `["cmd+shift+w"]`.
