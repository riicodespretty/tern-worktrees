---
name: tern-worktrees
description: Use to create, list, relocate or tear down git worktrees as Tern tabs with tern-wt. Replaces Orca worktrees.
---

# tern-worktrees

`tern-wt` keeps git worktrees in the worktree root, `~/.tern-wt/worktrees/<repo>/<slug>`, and shows each one as a Tern tab. The slug is the branch name with each `/` made `-`. A worktree in the root is a managed worktree.

## Rules

- Use `tern-wt` for worktrees, not `git worktree` or `orca worktree`.
- Run `remove` only on a worktree you created in this session, or one the user names.
- Pass `remove --force` only after the user says yes: it discards uncommitted work.
- Tabs that `create` opens are yours to close (skill://tern-cli). `remove` closes them.

## Output

Each command prints one JSON object to standard output.

- Exit 0: the result. Read its `warnings`: the command went on past each one.
- Exit 1: `{"error":{"code":"<code>","message":"<text>", ...}}`, plus the message on standard error. Some codes add fields: see [Error codes](#error-codes).

## Commands

### `create`

`tern-wt create --repo <dir> (--branch <name> [--new] | --pr <number>) [--relocate] [--no-tab]`

Makes or reuses the managed worktree of a branch and opens or focuses its tab.

- `--repo`: a dir in the repository.
- `--branch`: a local branch or a branch on `origin`.
- `--new`: make `--branch` as a new branch from `origin/<default>`. When the branch is local or on `origin`, it gives `bad_args`.
- `--pr`: the branch of a pull request. A pull request from a fork gets the branch `pr-<number>`.
- `--relocate`: move the worktree of the branch from a different path into the root. Pass it only after the user says yes.
- `--no-tab`: skip the tab.

Output: `{"path", "branch", "repo", "status", "tab", "warnings"}`.

- `status`: `created`, `reused` or `relocated`.
- `tab`: `{"session", "block", "opened"}`, or null with a `tab not opened:` warning. `opened` is false when an open tab got the focus.

### `remove`

`tern-wt remove <path> [--force] [--keep-tab]`

Removes the managed worktree at `<path>`, applies the teardown policy to its branch, then closes its tabs. `--keep-tab` keeps the tabs open.

Output: `{"removed", "branch", "branchDeleted", "closedBlocks", "warnings"}`. `branch` is null for a detached `HEAD`. A branch that the policy keeps adds the warning `kept branch <branch>: not merged`.

### `list`

`tern-wt list [--repo <dir>]`

Output: `{"root", "worktrees": [{"path", "repo", "branch", "dirty"}]}`. `--repo` limits the list to the repository that holds `<dir>`.

### `branches`

`tern-wt branches --repo <dir>`

Output: `{"repo", "name", "default", "branches", "prs": [{"number", "title", "branch", "fork"}], "worktrees": [{"branch", "path", "managed"}], "warnings"}`. `branches` lists the newest commit first.

### `resolve`

`tern-wt resolve <dir>...`

Output: `{"repos": [{"dir", "root", "name", "owner"}]}`. `root`, `name` and `owner` are null for a dir that is not in a repository.

### `repos`

`tern-wt repos`

Output: `{"owners", "repos": [{"nameWithOwner", "isPrivate", "description", "local"}], "warnings"}`. `owners` lists the GitHub user and each GitHub organization of the user. `local` is the clone in the clone root, or null.

### `clone`

`tern-wt clone <owner/name>`

Clones the GitHub repository to `<cloneRoot>/<owner>/<name>`, or reuses the clone there. Output: `{"root", "cloned"}`.

### `new-repo`

`tern-wt new-repo <owner/name> --visibility private|public`

Makes a GitHub repository with a README, then clones it. Run it only when the user asks for a new repository. Output: `{"root", "nameWithOwner"}`.

### `setup`

`tern-wt setup`

Links the Tern plugin, `~/.local/bin/tern-wt` and this skill to the checkout. A second run changes nothing. Output: `{"plugin", "links": [{"path", "target", "action"}]}`, with `plugin` `linked` or `already`, and `action` `created`, `kept` or `replaced`.

## Error codes

| Code                        | Added fields         | Next step                                                            |
| --------------------------- | -------------------- | -------------------------------------------------------------------- |
| `bad_args`                  |                      | Fix the arguments from the message.                                  |
| `config_invalid`            |                      | Show the user the message, which names the file and the key.         |
| `not_a_repo`                |                      | Pass a dir in a git repository.                                      |
| `not_managed`               |                      | `remove` acts only on a managed worktree. Get the paths from `list`. |
| `path_conflict`             | `path`               | Show the user `path`. Keep it as it is.                              |
| `branch_in_main_checkout`   | `existing`           | Tell the user. The main checkout holds the branch.                   |
| `worktree_exists_elsewhere` | `existing`, `target` | Ask the user, then run `create` again with `--relocate`.             |
| `dirty_worktree`            | `existing`, `files`  | Show the user `files`. Relocation needs a clean worktree.            |
| `git_failed`                |                      | Show the user the message. For `remove`, ask before `--force`.       |
| `gh_failed`                 |                      | Show the user the message. Check `gh auth status`.                   |
| `tern_failed`               |                      | Show the user the message. Check that Tern runs.                     |

## Config file

The file is `config.json` in the plugin data dir, the first of:

1. `$TERN_PLUGIN_DATA`, when set.
2. `$TERN_CONFIG_DIR/plugin-data/tern-worktrees`, when `TERN_CONFIG_DIR` is set.
3. `~/Library/Application Support/Tern/plugin-data/tern-worktrees` on macOS, and `${XDG_STATE_HOME:-~/.local/state}/tern/plugin-data/tern-worktrees` on other systems.

An invalid file makes each command fail with `config_invalid`. The keys:

- `teardown`: the teardown policy, the branch step of `remove` and of a closed worktree tab. `worktree` keeps the branch. `worktree+merged-branch`, the default, deletes a merged branch. `worktree+branch` deletes the branch. Merged means an ancestor of `origin/<default>`, or the branch of a merged pull request.
- `cloneRoot`: the dir for `clone` and `new-repo`. The default is `~/Developer`.
- `hotkeys.new`: the Tern key chords of the new worktree tab picker. The default is `["ctrl+b>w"]`.
