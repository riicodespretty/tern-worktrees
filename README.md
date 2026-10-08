# tern-worktrees

Git worktrees as [Tern](https://docs.stencil.so/tern) tabs, in three parts:

- The `tern-worktrees` Tern plugin. `cmd+shift+w` (W for worktree) opens the branch picker, and the branch you pick opens as a worktree tab. The command palette also lists the branches and pull requests of the current repository as worktree rows. When you close a worktree tab, the plugin offers a teardown.
- The `tern-wt` CLI, the one implementation of each git and GitHub step. The plugin runs it, and agents run it directly.
- The `tern-worktrees` omp skill, the contract that agents follow.

Each managed worktree lives in the worktree root, `~/.tern-wt/worktrees/<repo>/<slug>`. The slug is the branch name with each `/` changed to `-`. `TERN_WT_HOME`, when you set it, replaces `~/.tern-wt`.

## Requirements

- Tern 0.5.3 or a newer version.
- [bun](https://bun.sh).
- git.
- [gh](https://cli.github.com), logged in (`gh auth login`).

## Install

Use one of the two routes. `setup` reports `path_conflict` when Tern holds the plugin from a different folder.

### With `setup`

```sh
gh repo clone riicodespretty/tern-worktrees ~/Developer/riicodespretty/tern-worktrees
~/Developer/riicodespretty/tern-worktrees/bin/tern-wt setup
```

`setup` links the plugin into Tern, `~/.local/bin/tern-wt` to the CLI, and `~/.omp/agent/skills/tern-worktrees` to the skill. A second run keeps each link as it is.

### With `tern plugin install`

```sh
tern plugin install github.com/riicodespretty/tern-worktrees
```

This route installs the plugin only. Link the CLI and the skill by hand to a checkout of this repository:

```sh
mkdir -p ~/.local/bin ~/.omp/agent/skills
ln -s <checkout>/bin/tern-wt ~/.local/bin/tern-wt
ln -s <checkout>/skills/tern-worktrees ~/.omp/agent/skills/tern-worktrees
```

## Usage

### Open a worktree tab

1. Press `cmd+shift+w`. The branch picker opens for the repository of the current session. When the current session has no repository, the repo picker opens first.
2. Type to filter the open pull requests and the branches. A branch with a worktree shows `worktree` adjacent to its name.
3. Press Enter on a branch or a pull request. To start a new branch from `origin/<default>`, type its name and press Enter on `Create branch “<name>” from <default>`.

The worktree tab opens with the name of the branch, in the session of its repository, else in a new session named after the repository. When the worktree has a tab, the plugin focuses that tab.

Each dialog of the plugin opens where the command palette opens, and it looks like the palette. It uses the Tern theme colors, fonts, font size and interface style. In a dialog, a path in your home folder starts with `~`.

### Open a worktree from the command palette

In a pane of a repository or of one of its worktrees, the command palette (`cmd+shift+p`) shows the `Worktrees` group. This group has a worktree row for each branch and each open pull request:

- `<repo>: <branch>`, with ` · worktree` at the end when the branch has a worktree.
- `<repo>: #<n> <title>` for a pull request.

Press Enter on a row to open its worktree tab, as the branch picker does. The rows of a repository show only in its panes.

The rows refresh from local refs, with no network traffic. This refresh runs when a shell command ends in a pane of the repository and when one of its panes gets focus. It also runs after the plugin makes or removes a worktree. The fetch from `origin` and the list of open pull requests run at most one time in each Tern auto-fetch interval, the Tern setting `git.auto_fetch_minutes` (5 by default). When you set it to 0, Tern auto-fetch is off, and the rows refresh from local refs only. The pull request rows of an earlier fetch then stay as they are until Tern or the plugin reloads. After a reload with 0, no pull request rows show.

`cmd+shift+w` still opens the dialog. Use it to make a new branch or to select `Other repo…`.

### Select a different repository

In the branch picker, select `Other repo…`. The repo picker shows:

- Each repository open in a session, in the `Open sessions` group.
- `Browse GitHub repos…`, the repositories of your GitHub user and organizations. `tern-wt` clones the one you select to the clone root, or reuses the clone there.
- `Create new GitHub repo…`, which asks for the owner, the name and the visibility, then makes the repository and clones it.

The branch picker of that repository opens next.

### Relocate

A branch can have a worktree that is not in the worktree root, for example from Orca. When you pick that branch, a dialog offers Relocate or Cancel. Relocate moves the worktree into the root. When git refuses the move, `tern-wt` makes the worktree again in the root, but only when the first worktree has no work to lose. Work to lose is a changed file, a new file that git does not track, or a submodule commit that no remote holds. Then the worktree stays where it is, and a message lists that work.

Ignored files that are hard to rebuild, for example `.env` or `*.pem`, do not stop the rebuild: `tern-wt` copies them into the new worktree, in the submodules too, and lists them in `carried`. An ignored file is a build or install output when a part of its path is `node_modules`, `dist`, `build`, `coverage`, `.DS_Store`, `.cache`, `.next`, `.nuxt`, `.output` or `.turbo`. Those files stay behind. When a step after the copy fails, the error names the temporary folder that keeps the copies.

### Close a worktree tab

When you close a worktree tab, a dialog shows the path and the teardown policy:

- Tear down: removes the worktree, applies the teardown policy to its branch, then closes the tab. Ignored build and install output goes with the worktree. Ignored files that are hard to rebuild stop the teardown, as uncommitted changes do.
- Keep worktree: closes the tab and keeps the worktree.
- Cancel: keeps the tab and the worktree.

When the tab closes before the dialog opens, the dialog offers Keep worktree first, then Tear down. It opens without focus, so a key press meant for a different pane tears nothing down.

When the teardown fails, for example because of uncommitted changes or an ignored `.env` file, a second dialog shows the error and lists the files:

- Retry: runs the teardown again.
- Force delete: removes the worktree and discards its uncommitted work.
- Cancel: keeps the tab and the worktree.

## Options file

The options file is `config.json` in the first of these folders:

1. `$TERN_PLUGIN_DATA`, when you set it.
2. `$TERN_CONFIG_DIR/plugin-data/tern-worktrees`, when you set `TERN_CONFIG_DIR`.
3. `~/Library/Application Support/Tern/plugin-data/tern-worktrees` on macOS, and `${XDG_STATE_HOME:-~/.local/state}/tern/plugin-data/tern-worktrees` on other systems.

Each key in the file replaces its default:

| Key           | Default                    | Value                                                                                                                                                        |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `teardown`    | `"worktree+merged-branch"` | The teardown policy. `"worktree"` keeps the branch. `"worktree+merged-branch"` deletes the branch when it is merged. `"worktree+branch"` deletes the branch. |
| `cloneRoot`   | `"~/Developer"`            | The clone root, an absolute path or a path that starts with `~`. `tern-wt` clones a GitHub repository to `<cloneRoot>/<owner>/<name>`.                       |
| `hotkeys.new` | `["cmd+shift+w"]`          | The Tern key chords that open the branch picker. A change applies after `tern plugin reload`.                                                                |

A branch is merged when it is an ancestor of `origin/<default>`, or when its tip is the head commit of a merged pull request or an ancestor of that commit.

```json
{
  "teardown": "worktree",
  "cloneRoot": "~/src",
  "hotkeys": { "new": ["cmd+shift+w", "ctrl+b>w"] }
}
```

An invalid file, an unknown key or an incorrect value makes each `tern-wt` command fail with `config_invalid`.

### Bind `cmd+shift+w` in Tern settings

A Tern key preset or a different plugin can bind the chord first. When `cmd+shift+w` opens no picker, add the binding to the Tern `settings.json`:

```json
{
  "keybinds": { "cmd+shift+w": "plugin.tern-worktrees.new" }
}
```

## The `tern-wt` CLI and the agent skill

[`skills/tern-worktrees/SKILL.md`](skills/tern-worktrees/SKILL.md) is the reference for each command: its arguments, its output fields, the next step for each error code, and the rules agents follow for teardown. The commands:

- `create`: makes or reuses the managed worktree of a branch or a pull request, and opens its tab.
- `remove`: tears down a managed worktree as the teardown policy says, and closes its tabs.
- `list`: lists the managed worktrees.
- `branches`: lists the branches, the open pull requests and the worktrees of a repository. `--offline` reads only local refs, with no fetch and no pull requests.
- `resolve`: gives the repository root, name and owner of each directory.
- `repos`: lists the GitHub repositories of your user and organizations.
- `clone`: clones a GitHub repository to the clone root.
- `new-repo`: makes a GitHub repository, then clones it.
- `setup`: links the plugin, the CLI and the skill.

Each command prints one JSON object. On failure it exits 1 with one of these error codes: `bad_args`, `config_invalid`, `not_a_repo`, `not_managed`, `path_conflict`, `branch_in_main_checkout`, `worktree_exists_elsewhere`, `dirty_worktree`, `git_failed`, `gh_failed`, `tern_failed`.

The plugin also gives Carly the exports `create`, `list` and `remove`, which run the CLI commands of the same names.

## Design and glossary

[`docs/`](docs/README.md) holds the design and the glossary. CI publishes it to the [wiki](https://github.com/riicodespretty/tern-worktrees/wiki).

## License

MIT, in [`LICENSE`](LICENSE).
