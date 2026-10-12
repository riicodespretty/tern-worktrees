# tern-worktrees

Git worktrees as [Tern](https://docs.stencil.so/tern) tabs, in three parts:

- The `tern-worktrees` Tern plugin. `cmd+shift+w` (W for worktree) opens the branch picker, and the branch you pick opens as a worktree tab. The command palette also lists the branches and pull requests of the current repository as worktree rows. When you close a worktree tab, a Tern picker offers to keep the worktree or tear it down.
- The `tern-wt` CLI, the one implementation of each git and GitHub step. The plugin runs it, and agents run it directly.
- The `tern-worktrees` omp skill, the contract that agents follow.

Each tern-managed worktree lives in the worktree root, at `<root>/<repo>/<slug>`. The slug is the branch name with each `/` changed to `-`. The worktree root is `$TERN_WT_HOME/worktrees` when you set `TERN_WT_HOME`, else the omp worktree root when omp is installed, else `~/.tern-wt/worktrees`. See [Work with omp](#work-with-omp).

## Requirements

- Tern 0.8.0 or a newer version.
- [bun](https://bun.sh).
- git.
- [gh](https://cli.github.com), logged in (`gh auth login`).

## Install

Use one of the two routes. `tern-wt setup` reports `path_conflict` when Tern holds the plugin from a different folder.

### With `tern-wt setup`

```sh
gh repo clone riicodespretty/tern-worktrees ~/Developer/riicodespretty/tern-worktrees
~/Developer/riicodespretty/tern-worktrees/bin/tern-wt setup
```

`tern-wt setup` links the plugin into Tern, `~/.local/bin/tern-wt` to the CLI, and `~/.omp/agent/skills/tern-worktrees` to the skill. A second run keeps each link as it is.

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

1. Press `cmd+shift+w`. The branch picker opens over the focused pane, for the repository of the current session. When the current session has no repository, the repo picker opens first.
2. Type to filter. The branch picker lists `New branch…`, `Other repo…`, the open pull requests, then the branches. The label of a pull request row is `#<n> <title> · <branch>`, so you can also find the row when you type part of its branch name. A branch with a worktree shows `worktree` in dim text adjacent to its name. The filter reads only the row name, not the dim text.
3. Press Enter on a branch or a pull request. To start a new branch from `origin/<default>`, press Enter on `New branch…`. Type the branch name, then press Enter. When `tern-wt` refuses the name, a toast tells you why. The prompt then opens again and shows the name that you typed. If you press Escape, or press Enter with no name, the plugin makes no branch.

The first open of the branch picker for a repository in a Tern window waits for its branches and pull requests, with a `Loading branches…` toast. When the list is ready, a `Branches loaded` toast replaces it. Each subsequent open shows the last list at once and gets a new list in the background, with a `Refreshing branches…` toast. When the new list is ready, a toast tells you to reopen the picker to see the changes, or that it found no changes. When the refresh fails, an error toast gives the cause.

While `tern-wt` makes the worktree, a `Creating worktree <branch>…` toast shows, or `Reusing worktree <branch>…` when the branch has a worktree. When it is done, a `Created worktree` or `Reused worktree` toast replaces it. The worktree tab opens with the name of the branch, in the session of its repository, else in a new session named after the repository. When the worktree has a tab, the plugin focuses that tab.

Each picker, prompt and confirmation of the plugin uses the Tern picker or the Tern prompt. In a picker, a path in your home folder starts with `~`.

### Open a worktree from the command palette

In a pane of a repository or of one of its worktrees, the command palette (`cmd+shift+p`) shows the `Worktrees` group. This group has a worktree row for each branch and each open pull request:

- `<repo>: <branch>`, with ` · worktree` at the end when the branch has a worktree.
- `<repo>: #<n> <title>` for a pull request.

Press Enter on a row to open its worktree tab, as the branch picker does. The rows of a repository show only in its panes.

The rows refresh from local refs, with no network traffic. This refresh runs when a shell command ends in a pane of the repository and when one of its panes gets focus. It also runs after the plugin makes or removes a worktree. The fetch from `origin` and the list of open pull requests run at most one time in each Tern auto-fetch interval, the Tern setting `git.auto_fetch_minutes` (5 by default). When you set it to 0, Tern auto-fetch is off, and the rows refresh from local refs only. The pull request rows of an earlier fetch then stay as they are until Tern or the plugin reloads. After a reload with 0, no pull request rows show.

`cmd+shift+w` also opens the branch picker. Use the branch picker to select `New branch…` or `Other repo…`.

### Select a different repository

In the branch picker, select `Other repo…`. The repo picker shows:

- Each repository open in a session, in the `Open sessions` group.
- In the `GitHub` group, `Browse GitHub repos…`: the repositories of your GitHub user and organizations, grouped by owner. `tern-wt` clones the one you select to the clone root, or reuses the clone there. When GitHub lists no repository, a toast says so.
- In the `GitHub` group, `Create new GitHub repo…`, which asks for the owner, the name and the visibility (`Private` or `Public`), then makes the repository and clones it. When the name is empty, the plugin makes no repository.

The branch picker of that repository opens next.

### Relocate

A branch can have a worktree that is not in the worktree root, for example from Orca, or from `tern-wt` before you installed omp, in `~/.tern-wt/worktrees`. When you pick that branch, a picker reads `Worktree of this branch is at <path>` and offers `Relocate to <path>`. Enter relocates, and Escape keeps the worktree where it is. Relocate moves the worktree into the root.

When git refuses the move, `tern-wt` makes the worktree again in the root with plain `git worktree add`, also in omp clone mode, but only when the first worktree has no work to lose. Work to lose is a changed file, a new file that git does not track, or a submodule commit that no remote holds. Then the worktree stays where it is, and a message lists that work.

An omp-owned worktree of the branch needs no relocation: `tern-wt` opens its tab where it is.

Ignored files that are hard to rebuild, for example `.env` or `*.pem`, do not stop the rebuild: `tern-wt` copies them into the new worktree, in the submodules too, and lists them in `carried`. An ignored file is a build or install output when a part of its path is `node_modules`, `dist`, `build`, `coverage`, `.DS_Store`, `.cache`, `.next`, `.nuxt`, `.output` or `.turbo`. Those files stay behind. When a step after the copy fails, the error names the temporary folder that keeps the copies.

### Close a worktree tab

When you close a worktree tab, a picker opens with the placeholder `Closing worktree tab · <path>`. It shows two items. Keep worktree is the first item, so Enter keeps the worktree:

- Keep worktree: closes the tab and keeps the worktree.
- Tear down: removes the worktree, applies the teardown policy to its branch, then closes the tab. Its dim text says what the teardown policy does with the branch. Ignored build and install output goes with the worktree. Ignored files that are hard to rebuild stop the teardown, as uncommitted changes do. A copy goes with the worktree: an ignored file with the same bytes as the file at the same path in the main checkout, for example the `.env` that an omp clone copied. A changed copy stops the teardown.

Escape keeps the tab and the worktree. The picker has no `⌫` or `⌘⌫` keys. To select an item, type to filter the list or use the arrow keys. Then press Enter. When the picker fails to open, a toast shows the error. The tab closes, and the worktree stays.

When the tab closes before the picker opens, for example from the tab bar, the picker reads `Worktree tab closed · <path>` and offers the same two items. Escape keeps the worktree. This picker gets the focus, so a key press meant for a pane goes to the picker. A typed letter can hide Keep worktree, so check the selected item before you press Enter.

When the teardown fails, for example because of uncommitted changes, a new file that git does not track, or an ignored `.env` file, an error toast gives the cause, `Teardown failed: <cause>`. For a worktree with work to lose, the cause lists the files, at most 10. The ignored files that are hard to rebuild get the first positions in the 10. For the files that it does not show, the cause adds `and <n> more`. A second picker then shows the same `Teardown failed: <cause>` in its placeholder, for example `Teardown failed: 1 file with work to lose: ?? .setup-ran`, and offers:

- Retry: runs the teardown again.
- Force delete: removes the worktree and discards its uncommitted work. A `Deleting worktree <branch>…` toast shows while it runs, and a `Deleted worktree` toast replaces it when the worktree is gone.

Escape keeps the tab and the worktree.

### Worktree variables

A shell that starts in a worktree in the worktree root, or in a folder of one, gets three environment variables. The worktree can be tern-managed or omp-owned. The variables are:

- `TERN_WT_PATH`: the path of the worktree.
- `TERN_WT_MAIN`: the path of its main checkout.
- `TERN_WT_BRANCH`: its branch. A shell in a worktree with a detached `HEAD` does not get it.

A shell that starts in a folder that is not in the worktree root gets none of them. The values come from the last refresh of the plugin's list of worktrees, `tern-wt list --all`. The refresh runs at these times:

- A Tern window starts.
- A pane moves into a worktree in the root that is not on the list.
- A shell command ends, or a pane gets focus, in a worktree on the list.

A refresh from a pane or a shell command runs at most one time in 2 seconds. When the plugin makes or tears down a worktree, the list changes immediately. After a branch switch, a new shell gets the new branch after the next refresh. A shell keeps the variables it started with.

### Worktree segment

When the pane with the focus is in a worktree in the worktree root, or in a folder of one, the Tern status line shows the worktree segment. The worktree can be tern-managed or omp-owned. The segment shows the branch icon and the branch. When the worktree has `n` changed files, the segment adds `· <n>` and shows in the warning color, for example `⎇ feat · 2`. Without changed files, the segment shows the branch alone, in the muted color. A worktree with a detached `HEAD` shows `detached`.

A pane in a folder that is not in the worktree root shows no segment. The count is the number of changed files that `tern-wt list --all` gives. The count includes changes to tracked files, staged or not, new files that git does not track, and submodule changes. Ignored files do not count. The segment changes when the plugin's list of worktrees changes, at the times that [Worktree variables](#worktree-variables) gives.

Click the segment to open the branch picker, as `cmd+shift+w` does.

## Work with omp

When omp is on `PATH` and `TERN_WT_HOME` is not set, `tern-wt` shares omp's default worktree root, usually `~/.omp/wt`. It resolves the root as omp 18.8.6 does: `$OMP_WORKTREE_DIR`, else the omp setting `worktree.base`, else the `wt` folder of the omp data folder. omp removes the spaces at the two ends of each override, a leading `~` becomes the home folder, and a value that is still relative does not count. The omp data folder is `~/.omp`, or `~/$PI_CONFIG_DIR`, with `profiles/<profile>` added for the profile in `OMP_PROFILE` or `PI_PROFILE`. On Linux and macOS, `$XDG_DATA_HOME/omp` replaces it when that folder is on disk (`$XDG_DATA_HOME/omp/profiles/<profile>` for a profile). `tern-wt` reads the omp settings with `omp config list --json` run in `/`, so the config of a project does not move the root.

- A tern-managed worktree is at `<root>/<repo>/<slug>`, two levels below the root, where `<repo>` is the folder name of the main checkout.
- Each other worktree in the root is omp-owned, for example the `<n>-<hash>` folder of a pull request checkout or the folder of a `/wt` session. `list` shows omp-owned worktrees only with `--all`, `branches` marks them with `owner: "omp"`, `create` opens them where they are, and `remove` refuses them with `not_managed`.
- `create` finds an omp-owned worktree by its branch. omp checks out each pull request on the branch `pr-<n>`, so `create --pr <n>` reuses that checkout. For a pull request from the same repository, it does so when no worktree has the head branch and the git config key `branch.pr-<n>.ompPrHeadRef` that omp writes, when set, names that head branch.

When omp is on disk but `omp config list --json` fails in `/`, the worktree root is unknown, so `create`, `remove`, `list` and `branches` fail with `omp_failed` rather than use a different root. `tern-wt` uses `~/.tern-wt/worktrees` only when no omp binary is on disk.

Clone mode applies when omp is installed, also when `TERN_WT_HOME` is set: when the omp setting `worktree.clone` is true in the repository, project config included, `create` makes each new worktree with `omp worktree add`. A rebuilt relocation uses plain git. The new worktree starts as a copy-on-write clone of the main checkout, with its ignored files, for example `.env` and `node_modules`. A new branch gets the same upstream as with plain `git worktree add -b`. When the clone falls back to a plain checkout, the omp message shows in `warnings`. When `omp config list --json` fails in the repository, `create` uses plain git and adds a warning. omp 18.8.6 moves an invalid `.omp/config.yml` aside to `.omp/config.yml.broken-<id>` when it reads it, so that probe can change the repository.

`omp worktree clear` deletes each worktree in the root that omp sees as orphaned, also without `--all`. omp can see a live tern-managed worktree as orphaned, for example when git has `worktree.useRelativePaths=true` or when you moved the main checkout. Run `omp worktree clear --dry-run` first, and check its list.

## Options file

The options file is `config.json` in the first of these folders:

1. `$TERN_PLUGIN_DATA`, when you set it.
2. `$TERN_CONFIG_DIR/plugin-data/tern-worktrees`, when you set `TERN_CONFIG_DIR`.
3. `~/Library/Application Support/Tern/plugin-data/tern-worktrees` on macOS, and `${XDG_STATE_HOME:-~/.local/state}/tern/plugin-data/tern-worktrees` on other systems.

Each key in the file replaces its default:

| Key           | Default                    | Value                                                                                                                                                                                                  |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `teardown`    | `"worktree+merged-branch"` | The teardown policy. `"worktree"` keeps the branch. `"worktree+merged-branch"` deletes the branch when it is merged. `"worktree+branch"` deletes the branch.                                           |
| `cloneRoot`   | `"~/Developer"`            | The clone root, an absolute path or a path that starts with `~`. `tern-wt` clones a GitHub repository to `<cloneRoot>/<owner>/<name>`.                                                                 |
| `hotkeys.new` | `["cmd+shift+w"]`          | The Tern key chords that open the branch picker. A change applies after `tern plugin reload`.                                                                                                          |
| `setup`       | `{}`                       | The setup commands of each repository: its name with owner maps to a list of shell commands without line breaks. Uppercase and lowercase letters in the name are the same. An empty list runs nothing. |

A branch is merged when it is an ancestor of `origin/<default>`, or when its tip is the head commit of a merged pull request or an ancestor of that commit.

For a new worktree only, `tern-wt` types the commands of its repository into the new worktree tab as one line, with `&&` between them. The name with owner comes from the GitHub URL of `origin`, so a repository without a GitHub origin gets no setup commands. `tern-wt` waits a maximum of 30 s for the shell prompt of the tab before it types the line. When the tab was open before, no tab opens, the tab holds no new shell or no prompt shows, the commands do not run. A toast or a `create` warning shows why.

```json
{
  "teardown": "worktree",
  "cloneRoot": "~/src",
  "hotkeys": { "new": ["cmd+shift+w", "ctrl+b>w"] },
  "setup": { "virtusize/aoyama": ["npm ci", "npm run build"] }
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

- `create`: makes or reuses the tern-managed worktree of a branch or a pull request, or reuses its omp-owned worktree, and opens its tab. For a new worktree, its `setup` field holds the setup commands. `create` types them into the tab that it opened.
- `remove`: tears down a tern-managed worktree as the teardown policy says, and closes its tabs.
- `list`: lists the tern-managed worktrees, each with its `owner` and its number of `changed` files. `--all` adds the omp-owned worktrees.
- `branches`: lists the branches, the open pull requests and the worktrees of a repository, with the owner of each worktree. `--offline` reads only local refs, with no fetch and no pull requests.
- `resolve`: gives the repository root, name and owner of each directory.
- `repos`: lists the GitHub repositories of your user and organizations.
- `clone`: clones a GitHub repository to the clone root.
- `new-repo`: makes a GitHub repository, then clones it.
- `tern-wt setup`: links the plugin, the CLI and the skill.

Each command prints one JSON object. On failure it exits 1 with one of these error codes: `bad_args`, `config_invalid`, `not_a_repo`, `not_managed`, `path_conflict`, `branch_in_main_checkout`, `worktree_exists_elsewhere`, `dirty_worktree`, `git_failed`, `gh_failed`, `omp_failed`, `tern_failed`.

The plugin also gives Carly the exports `create`, `list` and `remove`, which run the CLI commands of the same names. For a new worktree with setup commands, the `create` export replies when the plugin typed them into the tab or gave up, at most 30 s after the tab opened, so `setup.typed` and `warnings` mean what they mean in the CLI output.

## Design and glossary

[`docs/`](docs/README.md) holds the design and the glossary. CI publishes it to the [wiki](https://github.com/riicodespretty/tern-worktrees/wiki).

## License

MIT, in [`LICENSE`](LICENSE).
