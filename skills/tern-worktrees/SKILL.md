---
name: tern-worktrees
description: Use to create, list, relocate or tear down git worktrees as Tern tabs with tern-wt. Replaces Orca worktrees.
---

# tern-worktrees

`tern-wt` keeps git worktrees in the worktree root, `~/.tern-wt/worktrees/<repo>/<slug>`, and opens each one in a Tern tab. The slug is the branch name with each `/` changed to `-`. A worktree in the root is a managed worktree.

## Rules

- Use `tern-wt` for worktrees, not `git worktree` or `orca worktree`.
- Run `remove` only on a worktree you created in this session, or one the user names.
- Pass `remove --force` only after the user says yes: it discards uncommitted work.
- Tabs that `create` opens are yours to close (skill://tern-cli). `remove` closes them.

## Output

Each command prints one JSON object to standard output.

- Exit 0: the result. Read its `warnings`. Each warning is a problem that did not stop the command.
- Exit 1: `{"error":{"code":"<code>","message":"<text>", ...}}`, plus the message on standard error. Some codes add fields: see [Error codes](#error-codes).

## Commands

### `create`

`tern-wt create --repo <dir> (--branch <name> [--new] | --pr <number>) [--relocate] [--no-tab]`

Makes the managed worktree of a branch, or reuses it. Then opens its tab, or focuses the tab that is open.

- `--repo`: a dir in the repository.
- `--branch`: a local branch or a branch on `origin`. A name that git rejects gives `bad_args`.
- `--new`: make `--branch` a new branch from `origin/<default>`. When the branch is local or on `origin`, `--new` gives `bad_args`, also when the branch has a worktree.
- `--pr`: the branch of a pull request. A pull request from a fork gets the branch `pr-<number>`.
- `--relocate`: move the worktree of the branch from a different path into the root. Pass it only after the user says yes. When git refuses the move, `create` makes the worktree again in the root, but only when the first worktree has no work to lose: a changed file, a new file that git does not track, or a submodule commit that no remote holds. Ignored files that are hard to rebuild (see `remove`) are copied into the new worktree.
- `--no-tab`: skip the tab.

Output: `{"path", "branch", "repo", "status", "carried", "tab", "warnings"}`.

- `status`: `created`, `reused` or `relocated`.
- `carried`: the ignored files, as paths in the worktree, that a rebuilt relocation copied into the new worktree. Empty otherwise. When the new worktree has a file at that path, the copy stays in the temporary folder, with a `not carried:` warning.
- `tab`: `{"session", "block", "opened"}`, or null with a `tab not opened:` warning. `opened` is false when `create` focused a tab that was open before.

### `remove`

`tern-wt remove <path> [--force] [--keep-tab]`

Removes the managed worktree at `<path>`, closes its tabs, then applies the teardown policy to its branch. `--keep-tab` keeps the tabs open. A worktree with a changed file, a new file that git does not track, a submodule commit that no remote holds, or an ignored file that is hard to rebuild gives `dirty_worktree` and stays. An ignored file is build or install output when a part of its path is `node_modules`, `dist`, `build`, `coverage`, `.DS_Store`, `.cache`, `.next`, `.nuxt`, `.output` or `.turbo`. That output goes with the worktree. Each other ignored file, for example `.env`, is hard to rebuild. `--force` deletes all of them.

Output: `{"removed", "branch", "branchDeleted", "closedBlocks", "warnings"}`. `branch` is null for a detached `HEAD`. A branch that the policy keeps adds the warning `kept branch <branch>: not merged`.

### `list`

`tern-wt list [--repo <dir>]`

Output: `{"root", "worktrees": [{"path", "repo", "branch", "dirty"}]}`. With `--repo`, `list` shows only the worktrees of the repository that contains `<dir>`.

### `branches`

`tern-wt branches --repo <dir> [--offline]`

- `--offline`: read only local refs. It does not run `git fetch --prune origin`, does not list the open pull requests, and does not ask GitHub for the default branch. `prs` is `[]`, and `branches` has the branches on `origin` as of the last fetch. When `origin/HEAD` is unset, `default` is the current branch.

Output: `{"repo", "name", "default", "branches", "prs": [{"number", "title", "branch", "fork"}], "worktrees": [{"branch", "path", "managed"}], "warnings"}`. `branches` is sorted by the date of the last commit on each branch, newest first. It has the local branches and the branches on `origin`, each once. When `gh pr list` fails, `prs` is `[]` and `warnings` has an entry that starts with `pr list failed:`. The Tern window uses that prefix to find a failed pull request list.

### `resolve`

`tern-wt resolve <dir>...`

Output: `{"repos": [{"dir", "root", "name", "owner"}]}`. `root`, `name` and `owner` are null for a dir that is not in a repository.

### `repos`

`tern-wt repos`

Output: `{"owners", "repos": [{"nameWithOwner", "isPrivate", "description", "local"}], "warnings"}`. `owners` is the GitHub user, then each GitHub organization of that user. `local` is the clone in the clone root, or null.

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
| `not_managed`               |                      | `remove` acts only on a managed worktree. Get the paths from `list`.                                                                                                                 |
| `path_conflict`             | `path`               | Show the user `path`. Keep it as it is.                                                                                                                                              |
| `branch_in_main_checkout`   | `existing`           | Tell the user. The main checkout holds the branch.                                                                                                                                   |
| `worktree_exists_elsewhere` | `existing`, `target` | Ask the user, then run `create` again with `--relocate`.                                                                                                                             |
| `dirty_worktree`            | `existing`, `files`  | Show the user `files`. An entry `!! <path>` is an ignored file that is hard to rebuild. Relocate and `remove` keep a worktree with work to lose. For `remove`, ask before `--force`. |
| `git_failed`                |                      | Show the user the message. For `remove`, ask before `--force`.                                                                                                                       |
| `gh_failed`                 |                      | Show the user the message. Check `gh auth status`.                                                                                                                                   |
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
- `hotkeys.new`: the Tern key chords that open the picker for a new worktree tab. The default is `["ctrl+b>w"]`.
