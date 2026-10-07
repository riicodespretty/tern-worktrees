# tern-worktrees

Git worktrees as [Tern](https://docs.stencil.so/tern) tabs. The repository holds three parts:

- The `tern-worktrees` Tern plugin. One key opens a branch picker, and the branch you pick opens as a tab in its own worktree. When you close the tab, the plugin asks to tear the worktree down.
- The `tern-wt` CLI. It does each git and GitHub step for the plugin, and agents use it directly.
- The `tern-worktrees` omp skill. It teaches agents the `tern-wt` commands and rules.

Each worktree goes in the worktree root, `~/.tern-wt/worktrees/<repo>/<slug>`. The slug is the branch name with each `/` changed to `-`.

## Requirements

- Tern 0.5.3 or a newer version.
- [bun](https://bun.sh).
- git.
- [gh](https://cli.github.com), logged in (`gh auth login`).

## Install

Clone the repository to `~/Developer/riicodespretty/tern-worktrees`, then run `setup`:

```sh
gh repo clone riicodespretty/tern-worktrees ~/Developer/riicodespretty/tern-worktrees
~/Developer/riicodespretty/tern-worktrees/bin/tern-wt setup
```

`setup` links the plugin into Tern, links `~/.local/bin/tern-wt` to the CLI, and links `~/.omp/agent/skills/tern-worktrees` to the skill. You can run it again: a second run changes nothing.

You can also install the plugin with Tern:

```sh
tern plugin install github.com/riicodespretty/tern-worktrees
```

With this install, also link two paths to a checkout: `~/.local/bin/tern-wt` to its `bin/tern-wt`, and `~/.omp/agent/skills/tern-worktrees` to its `skills/tern-worktrees` folder.

## Usage

### Open a worktree tab

1. Press `ctrl+b w`. The branch picker opens for the repository of the current session. When the current session has no repository, the repo picker opens first.
2. Type to filter the open pull requests and the branches. A branch with a worktree shows `· worktree`.
3. Press Enter on a branch or a pull request. To make a new branch from `origin/<default>`, type its name and press Enter on `Create branch “<name>” from <default>`.

The tab opens with the name of the branch, in the session of that repository. When no session shows that repository, a new session opens. When the worktree has a tab, that tab gets the focus.

### Use a different repository

In the branch picker, select `Other repo…`. The repo picker shows:

- Each repository open in a session, in the `Open sessions` group.
- `Browse GitHub repos…`, which lists the repositories of your GitHub user and organizations. When you select one that is not in the clone root, `tern-wt` clones it there.
- `Create new GitHub repo…`, which asks for the owner, the name and the visibility, then makes and clones the repository.

The branch picker of the selected repository opens next.

### Relocate

A branch can have a worktree that is not in the worktree root, for example from Orca. When you pick that branch, a dialog asks to move it into the root: select Relocate or Cancel. When git cannot move the worktree and it has no uncommitted changes, `tern-wt` makes it again in the root. When it has uncommitted changes, the worktree stays where it is, and a message lists the changed files.

### Close a worktree tab

When you close a worktree tab, a dialog shows the path and the teardown policy:

- Tear down: removes the worktree, then applies the teardown policy to its branch. The tab closes after the removal.
- Keep worktree: closes the tab and keeps the worktree.
- Cancel: keeps the tab and the worktree.

When the tab closed before the dialog, for example with the × on the tab bar, the dialog shows Tear down and Keep worktree only.

When the teardown fails, for example because of uncommitted changes, a second dialog shows the error:

- Retry: tries the teardown again.
- Force delete: removes the worktree and discards its uncommitted changes.
- Cancel: keeps the tab and the worktree.

## Options file

The options file is `config.json` in the first of these folders:

1. `$TERN_PLUGIN_DATA`, when you set it.
2. `$TERN_CONFIG_DIR/plugin-data/tern-worktrees`, when you set `TERN_CONFIG_DIR`.
3. `~/Library/Application Support/Tern/plugin-data/tern-worktrees` on macOS, and `${XDG_STATE_HOME:-~/.local/state}/tern/plugin-data/tern-worktrees` on other systems.

When the file is missing, each key has its default. Each key in the file replaces its default.

| Key           | Default                    | Value                                                                                                                                                        |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `teardown`    | `"worktree+merged-branch"` | The teardown policy. `"worktree"` keeps the branch. `"worktree+merged-branch"` deletes the branch when it is merged. `"worktree+branch"` deletes the branch. |
| `cloneRoot`   | `"~/Developer"`            | The clone root. `tern-wt` clones a GitHub repository to `<cloneRoot>/<owner>/<name>`.                                                                        |
| `hotkeys.new` | `["ctrl+b>w"]`             | The Tern key chords that open the picker. A change applies after `tern plugin reload`.                                                                       |

A branch is merged when it is an ancestor of `origin/<default>`, or when a merged pull request has it as its head branch.

An example:

```json
{
  "teardown": "worktree",
  "cloneRoot": "~/src",
  "hotkeys": { "new": ["ctrl+b>w", "ctrl+shift+w"] }
}
```

An invalid file, an unknown key or an incorrect value makes each `tern-wt` command fail with `config_invalid`.

### When `ctrl+b w` does nothing

A Tern key preset can block the chord. Add the binding to the Tern `settings.json`:

```json
{
  "keybinds": { "ctrl+b>w": "plugin.tern-worktrees.new" }
}
```

## The `tern-wt` CLI

Each command prints one JSON object to standard output. On success it exits 0. On failure it exits 1, prints `{"error":{"code":"<code>","message":"<text>", ...}}`, and writes the message to standard error.

| Command                                                                                  | What it does                                                                                                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `create --repo <dir> (--branch <name> [--new] \| --pr <number>) [--relocate] [--no-tab]` | Makes or reuses the worktree of a branch or a pull request in the worktree root, and opens or focuses its tab.          |
| `remove <path> [--force] [--keep-tab]`                                                   | Removes a managed worktree, applies the teardown policy to its branch, and closes its tabs. `--force` discards changes. |
| `list [--repo <dir>]`                                                                    | Lists the managed worktrees, with their repository, branch and dirty state.                                             |
| `branches --repo <dir>`                                                                  | Lists the branches, the open pull requests and the worktrees of a repository.                                           |
| `resolve <dir>...`                                                                       | Gives the repository root, name and owner of each directory.                                                            |
| `repos`                                                                                  | Lists the GitHub repositories of your user and organizations, with the local clone of each.                             |
| `clone <owner/name>`                                                                     | Clones a GitHub repository to the clone root, or reuses the clone there.                                                |
| `new-repo <owner/name> --visibility private\|public`                                     | Makes a GitHub repository with a README, then clones it.                                                                |
| `setup`                                                                                  | Links the Tern plugin, `~/.local/bin/tern-wt` and the omp skill to the checkout.                                        |

The error codes:

| Code                        | Meaning                                                                         |
| --------------------------- | ------------------------------------------------------------------------------- |
| `bad_args`                  | The arguments are incorrect, or the command is unknown.                         |
| `config_invalid`            | The options file is invalid. The message names the file and the key.            |
| `not_a_repo`                | The directory is not in a git repository.                                       |
| `not_managed`               | The path is not a managed worktree.                                             |
| `path_conflict`             | Something else is at the path. The `path` field names it.                       |
| `branch_in_main_checkout`   | The main checkout holds the branch. The `existing` field names it.              |
| `worktree_exists_elsewhere` | The branch has a worktree at a different path. Pass `--relocate` to move it.    |
| `dirty_worktree`            | The worktree to relocate has uncommitted changes. The `files` field lists them. |
| `git_failed`                | A git command failed.                                                           |
| `gh_failed`                 | A gh command failed. Check `gh auth status`.                                    |
| `tern_failed`               | A Tern command failed. Check that Tern runs.                                    |

The full contract, with each output field, is in the agent skill.

## The agent skill

[`skills/tern-worktrees/SKILL.md`](skills/tern-worktrees/SKILL.md) teaches omp agents to use `tern-wt`, not `git worktree` or `orca worktree`. It also gives the rules for teardown: an agent removes only a worktree that it made or that the user names, and uses `--force` only after the user agrees.

The plugin also gives Carly the exports `create`, `list` and `remove`, which run the same CLI commands.

## Docs

The design and the glossary are in [`docs/`](docs/Home.md), which CI publishes to the [wiki](https://github.com/riicodespretty/tern-worktrees/wiki).

## License

MIT.
