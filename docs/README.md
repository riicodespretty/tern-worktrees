# tern-worktrees

`tern-worktrees` shows git worktrees as Tern tabs. This page tells how the plugin works and why. Install and usage are in the [README](https://github.com/riicodespretty/tern-worktrees/blob/main/README.md), and the terms are in the [glossary](GLOSSARY.md). Agents read three more docs: the [issue tracker](agents/issue-tracker.md), the [domain docs](agents/domain.md) and the [triage labels](agents/triage-labels.md).

## Why worktrees move from Orca to Tern

Before this plugin, Orca made the worktrees and showed each one in its own app. The user works in the terminal in Tern, so each worktree was in two apps, with two lists of open work. With this plugin, Tern opens each worktree as a tab in the session of its repository, and closing the tab asks to tear the worktree down. Agents use the same `tern-wt` CLI, so a worktree that an agent makes is a tab that the user sees.

A branch can still have an Orca worktree. When the user picks that branch, the plugin offers to relocate the worktree into the worktree root. After a relocation, Orca shows the previous path as missing. The plugin does not change the Orca data.

## Architecture

The design has three parts:

- `tern-wt`, a Bun and TypeScript CLI in `src/`, the single implementation. Each git and gh step runs in the CLI.
- The window half of the plugin, `window.luau`, a thin UI over the CLI. It opens the native pickers and prompts of Tern, turns each answer into a CLI call, and keeps each worktree tab matched to its worktree. It also keeps the worktree rows of the command palette, the worktree index and the worktree segment current. It types the setup commands into a new worktree tab.
- The host half of the plugin, `host.luau`. It holds only the spawn filter. The filter gives the worktree variables to a new shell in a worktree in the worktree root.

The omp skill and the Carly exports give agents the same CLI, so the user and the agents get the same behavior.

### The CLI

Each command prints one JSON object, and each failure has an error code. The window half reads the code to select its next step. For example, `worktree_exists_elsewhere` opens the Relocate picker. The CLI uses only `node:` built-in modules, so Bun runs it from source and Vitest tests the same files.

`branches` lists the local branches and the branches on `origin`, each once, newest commit first. `branches --offline` reads only local refs: no fetch, no pull request list and no GitHub lookup of the default branch. The worktree rows use it, so most of their refreshes cost no network traffic.

### omp

omp makes worktrees too: pull request checkouts, `/wt` session worktrees and task sandboxes, all in one worktree root. When omp is installed, `tern-wt` uses that root, omp's default worktree root, usually `~/.omp/wt`, so the user has one folder for all worktrees, and omp lists the managed worktrees as its own. `TERN_WT_HOME` still wins, so the tests and the smoke test do not touch the real root. `src/omp.ts` is the one module that runs omp.

omp does not print its root in `omp config list`, so `ompRootDir` in `src/paths.ts` copies the rule of omp 18.8.6: `$OMP_WORKTREE_DIR`, else the omp setting `worktree.base`, else `<data root>/wt`. The spaces at the two ends of each override do not count, a leading `~` becomes the home folder of the OS, a value that is still relative does not count, and the result is normalized without a trailing separator, so the window half can match path prefixes. The data root is `~/<PI_CONFIG_DIR or .omp>`, plus `profiles/<profile>` for the profile in `OMP_PROFILE`, or in `PI_PROFILE` when `OMP_PROFILE` is not set. On Linux and macOS, with the default agent folder, `$XDG_DATA_HOME/omp` (or `$XDG_DATA_HOME/omp/profiles/<profile>`) replaces it when that folder is on disk. The unit tests inject the env, the platform and the file check, and a check against the real omp in scratch home folders gave the same root for each case.

The root comes from `omp config list --json` run in `/`, so the config of a project cannot move it. When omp is on disk but that command fails or prints no JSON object, the commands that need the root fail with `omp_failed`. A fallback to `~/.tern-wt/worktrees` can put new worktrees where omp does not see them, hide the managed worktrees from `list` and `remove`, and relocate an omp-owned worktree, so the CLI fails closed. `~/.tern-wt/worktrees` is the root only when no omp binary is on disk.

Clone mode comes from the same command run in the repository, so the config of the project applies, and it applies for each root, `TERN_WT_HOME` included. When that run fails, `create` uses plain git and adds a warning. omp 18.8.6 moves an invalid `.omp/config.yml` aside to `.omp/config.yml.broken-<id>` when it reads it, so this probe can change the repository.

A worktree at `<root>/<repo>/<slug>` is a managed worktree. Each other worktree in the root is omp-owned: `create` opens it where it is, `list` does not show it, `branches` marks it with `owner: "omp"`, and `remove` refuses it with `not_managed`. `create` matches an omp-owned worktree by its branch. omp checks out pull request `<n>` on the branch `pr-<n>`, also for a pull request from the same repository, where `create --pr` targets the head branch. Thus, when no worktree has the head branch, `create` reuses the omp-owned worktree on `pr-<n>` when the git config key `branch.pr-<n>.ompPrHeadRef` that omp writes is not set or names the head branch.

`omp worktree clear` deletes each worktree in the root that omp sees as orphaned, also without `--all`, and `--all` deletes each one, all with no check for uncommitted changes. omp sees a live managed worktree as orphaned when git has `worktree.useRelativePaths=true`, or when the main checkout moved. The plugin cannot stop that, so the docs tell the user to run `omp worktree clear --dry-run` first.

In clone mode, `create` runs `omp worktree add`, and the new worktree starts with copies of the ignored files of the main checkout, for example `.env`. omp sets no upstream, so for a new branch `create` first runs `git branch`, which applies `branch.autoSetupMerge` as `git worktree add -b` does, then lets omp check out that branch. Thus `--new` gets the same upstream in the two modes. The teardown skips an ignored file with the bytes of the file at the same path in the main checkout: it compares the sizes, then the bytes in fixed-size chunks, and stops at the first difference, so a large artifact does not load into memory. A rebuilt relocation uses plain `git worktree add`, because it copies the ignored files of the first worktree, and a clone puts the copies of the main checkout there first.

### Worktree rows

The window half knows each repository from the `cwd` of a pane. With `tern.command`, it registers one Tern command in the `Worktrees` group for each branch and each open pull request of that repository. A row runs `tern-wt create`, as the branch picker does. Its `available` hook only reads tables: the row shows when the `cwd` of the active pane belongs to its repository. A branch that goes away keeps its command, and `available` hides it. Tern ranks the rows, and the plugin sets only their titles.

Two types of refresh keep the rows current:

- A local refresh runs `tern-wt branches --offline`. It keeps the pull request rows of the last network refresh.
- A network refresh runs `tern-wt branches`, which fetches `origin` and lists the open pull requests. A trigger gets a network refresh, not a local one, when the last network refresh of that repository is older than `git.auto_fetch_minutes`. The window half reads that Tern setting at each trigger. With 0, no network refresh starts. The pull request rows of an earlier network refresh stay, with no update, until the window or the plugin reloads. When the pull request list fails, the rows keep the earlier pull request rows.

These events start a refresh:

- The start of the window, for each repository open in a session.
- Focus on a pane.
- A change of the `cwd` of the active pane.
- The `command_finished` event, when a shell command in a pane ends.
- A create or remove that succeeds, from the plugin or from the Carly exports.

One refresh for each repository runs at a time. A trigger during a refresh queues one more refresh.

### Native pickers and prompts

Each picker, prompt and confirmation of the plugin is a native dialog of Tern: `cx:pick` for a list, and `cx:prompt` for a line of text. The two open over the pane with the focus.

In the 0.1.0 release (tag `0.1.0`), the plugin showed its own dialog in a floating block. Tern gives the plugin an incorrect id for a pane with an id generation above `0xfff`: for a pane of generation `0x106d`, the plugin API sees `0x6d`. With that id, the float of the custom dialog failed, and the dialog split the pane. The incorrect id is a bug in Tern. `cx:pick` and `cx:prompt` work from such a pane. Tern 0.7.1 added them, and the minimum Tern for the plugin is 0.8.0.

A native dialog gives its answer through its `Awaitable`. The `:next` callback gets the answer, an error text and a new `cx`. In `window.luau`, `choose` wraps `cx:pick` and `prompt_text` wraps `cx:prompt`. When their callback gets a nil `cx`, it returns immediately, as the callback of `cli` does. When their callback gets an error, it shows the `Picker failed` or `Prompt failed` toast with the error, then gives the error to the next step.

Escape gives nil. Enter on an empty prompt gives `""`, and the plugin reads it as Escape. Tern keeps the state of an open dialog, so the plugin keeps no record of it and installs no CSS.

`cx:pick` filters on the label of each item only, not on its dim text (`detail`). Thus a pull request item of the branch picker has its branch in its label: `#<n> <title> · <branch>`. A query with part of the branch name then finds the item. The `worktree` text of a branch with a worktree is dim text, so a query for `worktree` does not find that branch.

`New branch…` opens a prompt for the name. `cx:prompt` checks nothing while the user types, so the CLI checks the name on Enter. When `create` refuses the name with `bad_args`, a toast tells why, and the prompt opens again with the typed name.

The native picker has no keys of its own for an item. Thus Tear down has no `⌫` key and Force delete has no `⌘⌫` key: the user selects the item and presses Enter. In the pickers that open when a worktree tab closes, Keep worktree is the first item, so Enter keeps the worktree. The custom dialog of a closed tab opened without the focus, but the native picker gets the focus. Thus a key that the user types for a pane goes to the picker, and a typed letter can hide Keep worktree.

### Pickers and sessions

When the hotkey runs, the window half sends the working directory of each pane to `tern-wt resolve`, which gives the repository root of each one. The current session gets the branch picker of its repository, else the repo picker opens. A new worktree tab opens in the session of its repository, else in a new session. When `resolve` fails, the picker still opens. When the root of a repository is unknown, that repository matches no session.

When the user presses the hotkey again before a picker opens, the newest press wins: the `resolve` and `branches` calls of the older presses end with no picker, so one picker opens, and no picker opens after the user closes it.

### The branch picker cache

`tern-wt branches` fetches `origin`, lists the open pull requests and asks GitHub for the default branch. On one real repository it ran for 9.6 s, against 0.1 s for `branches --offline` and 0.05 s for `resolve`. A branch picker that waits for it opens 9.6 s after the hotkey. Thus the window half keeps the last `branches` answer of each repository root, the branch picker cache. The first open of a branch picker in a window waits for `branches`, as before, and keeps the answer. Each subsequent open shows the cache at once, and runs `branches` again in the background, with the fetch and the GitHub calls, at each open. Its answer is in the next open. A picker that is open cannot change: Tern 0.8.0 fixes the items of `cx:pick` when it opens.

Each repository root has at most one background `branches` at a time. A request during a run runs one more after it, so an answer that started before a change does not stay in the cache. That second run is online when one of the requests during the run is online. A failed background run keeps the cache and shows no toast, because the user did not wait for it. A failed first open shows its error, and the next open waits for `branches` again.

After a create, the cache of its repository refreshes with `branches --offline`. After a teardown, each cache refreshes the same way, because the window half does not know the repository of the removed worktree there. Local refs are sufficient for the `worktree` text, and the worktree rows can run their own `branches` at the same time, so a second `git fetch` on the same repository is not necessary. `--offline` gives no pull requests, so the cache keeps the pull requests and the default branch of its last online answer. Until the refresh answers, the picker can show a branch with no `worktree` text that has a worktree at this time, or the reverse. A selection in a picker from the cache still works, because `create` reads the branch again: it opens the current worktree of the branch, or makes one. A branch that is gone since gets the error of `create`.

The cache is in the memory of the window, not in `tern.kv`. A reload of the plugin or a new window waits for `branches` one time. A cache in `tern.kv` can save that one wait, but each window writes the same key, so each read must check the shape and merge with the other windows, as the worktree index does. Also, the answer of a window that closed days before then shows at once.

### Close interception

Each tab with a pane in a managed worktree is a worktree tab. The window half keeps a map from each tab to its worktree. It updates the map when a tab or pane opens, or when a working directory changes. A pane is in a managed worktree when its working directory is in `<root>/<repo>/<slug>`, and the `.git` file of `<root>/<repo>/<slug>` names a main checkout with the name `<repo>`. This is the same test as the one in the CLI. Thus a pane in an omp-owned worktree, for example `<root>/12-abc1234/src` or a task sandbox at `<root>/t<hash>/m`, is not in a managed worktree. The window half does not add an omp-owned worktree that `create` opens to the map, so closing its tab opens no picker.

When the window starts, the window half reads the root from the `root` field of `tern-wt list --all`, removes a trailing `/`, and keeps the last root in `tern.kv`. At load it cannot wait for the CLI, so it starts from the kept root, else from `~/.tern-wt/worktrees`. `TERN_WT_HOME` wins over the two. When `list` fails, for example with `omp_failed`, the window half keeps the root that it has.

Two paths catch the close of a worktree tab:

- The `close_tab` and `close_pane` overrides catch the close keys before the tab closes. `close_pane` catches only the last pane of a tab. The picker reads `Closing worktree tab · <path>` and lists Keep worktree, then Tear down. The tab closes after Keep worktree, or after the teardown succeeds. Escape cancels: the tab and the worktree stay. When the picker gives an error, the window half counts it as Keep worktree, so the tab can always close.
- The `tab_closed` event catches the other closes in the window, for example the tab bar or the tab menu. At that time the tab is closed, so the picker reads `Worktree tab closed · <path>`, with the same two items. Escape keeps the worktree.

A tab with panes in two or more worktrees gets one picker for each worktree, one after the other.

`tern close <block>` on the only pane of a worktree tab closes the tab, and the window half shows no picker (seen on Tern 0.8.0, with a second tab open). A close of the tab in the window that does not go through the close keys, for example `tern ctl tab close`, opens the `Worktree tab closed` picker. After `tern close`, the worktree stays on disk until `tern-wt remove` tears it down.

A tab that shares its worktree with a different open tab closes with no picker. `tern-wt remove` removes the worktree before it closes the tabs, so an agent teardown shows no picker.

Tern can park a pane: the pane goes out of its tab, and its program goes on in the deck of the session. A parked pane has no tab. A parked pane in a worktree counts as a pane of a different tab. Thus, a park that closes the last tab of a worktree opens no picker.

A worktree can have one or more parked panes and no pane in a tab. When the user opens a worktree of this type, the window half calls `unpark` on the first parked pane. The window half puts that pane in a tab of the session of the repository, with the name of the branch:

- When that session has a tab, the window half switches to the session and moves the pane to a new tab.
- When that session has no tab, because all of its panes are parked, the window half switches to the session, opens a tab, deals the pane into it and closes the shell of that tab.
- When no session of the repository is open, the window half first makes that session, deals the pane into its first tab and closes the shell that the new session started.

The window half finds the session of a repository from the folders of the panes in its tabs. A parked pane has no session in the pane list of Tern, so the window half keeps the repository of a session when all of its panes become parked. It loses that record when it loads again, for example after `tern plugin reload`. When it then opens the worktree, and all the panes of the session of the repository are parked, it makes a second session for the repository. When a move fails, the window half parks the pane again and opens a new tab.

When a teardown fails, an error toast names the worktree by its folder name and tells why. For a worktree with work to lose, the toast lists at most 10 files. The hard-to-rebuild files get the first positions in the 10, and the changes fill the positions that are left. The toast gives the changes first, then the hard-to-rebuild files, then `and <n> more` for the files that it does not show. In the message of a different error, the folder name replaces the path of the worktree: a full path in the worktree root is so long that the error after it does not fit in the toast or the picker.

A picker then lists Retry, then Force delete. Its placeholder, `Teardown failed · <folder> · <cause>`, gives the same cause as the toast, so the user sees it while they select, also after the toast goes. Escape keeps the worktree, and after the close keys it also keeps the tab. Tear down and Force delete are the two steps of a removal: Tear down stops when the worktree has work to lose, and only Force delete discards that work.

### The worktree index

The worktree index lists each worktree in the worktree root, managed and omp-owned, by its path. Each entry gives the main checkout, the branch and the number of changed files of its worktree. It comes from `tern-wt list --all`: `--all` adds the omp-owned worktrees, and each worktree in the output has its `owner` and its number of `changed` files. The window half keeps the index in `tern.kv`, with the key `worktreeIndex`. The host half and each window read that key.

Three writes change the index:

- A `list --all` result replaces the whole index. A `list --all` runs when the window starts. A refresh also runs it when the `cwd` of a pane moves to a folder in the worktree root that the index does not have. A refresh also runs it when a pane in an indexed worktree gets focus or ends a shell command. At most one `list --all` runs at a time, and a refresh starts at most one in each 2 s. A refresh request in that gap waits, and a timer runs it one time at the end of the gap. The new index keeps the value of this window for each entry that this window set or deleted at or after the start of that `list --all`.
- `open_tab` sets the entry of the worktree before it opens the tab, so the first shell of the tab gets the worktree variables.
- A teardown that succeeds deletes the entry, also from the Carly `remove` export.

Each window writes the same key. Thus `set_entry` reads `tern.kv` again and changes only its one entry, so a window keeps the entries of the other windows.

### The spawn filter

`host.luau` holds one handler, the `spawn` filter. Tern runs it before a shell pane starts and waits 50 ms for it, so the filter runs no process and calls no CLI.

It reads the worktree index from `tern.kv`, expands a leading `~` in the `cwd` of the shell, and selects the longest path in the index that holds that `cwd`. It then gives the shell `TERN_WT_PATH`, `TERN_WT_MAIN` and `TERN_WT_BRANCH`. A worktree with a detached `HEAD` gets no `TERN_WT_BRANCH`. When `tern.kv` has no index, when no path matches, or when the filter raises an error, it returns nil, and the shell starts with no change. Tern gives the filter `spec.args` and `spec.env` as read-only tables, which `table.clone` refuses, so the filter copies them field by field.

### The worktree segment

`tern.chrome.status` gives the worktree segment of the pane with the focus: the branch, plus ` · <n>` when the worktree has `n` changed files. A worktree with a detached `HEAD` shows `detached`. The tone applies to the full segment: muted when the worktree has no changed files, and the warning tone when it has one or more. The formatter reads only the worktree index. Tern disables a formatter that runs for more than 4 ms, and a formatter cannot call `tern.chrome.refresh`. Tern keeps the segments that a formatter gave, so after an index write that changes a segment, the window half calls `tern.chrome.refresh` one time. A change to a segment is a new or a removed worktree, or a different branch or number of changed files. A click on the segment runs the `New worktree tab` command, as the hotkey does: it opens the branch picker of the repository of the current session, else the repo picker.

### Setup commands

The options file lists the setup commands in the `setup` key, by the name with owner of a repository. `create` reads them only for a new worktree, with the status `created`, and only when the URL of `origin` names a GitHub repository. It joins the commands into one line with `&&` between them. The output gives that line in `setup.line`. Two paths type the line into the shell of the new worktree tab:

- When `create` opens the tab, it waits a maximum of 30 s for the shell prompt with `tern wait <block> --until prompt`, then types the line with `tern run`. `setup.typed` is true when `create` typed the line.
- The plugin runs `create --no-tab` and opens the tab itself. `type_setup` then reads `at_prompt` of the new shell pane each 200 ms, for a maximum of 30 s, and types the line with `cx:run`. The Carly `create` export replies only after the plugin types the line or gives up, so `setup.typed` and the warnings tell the agent the result.

When the tab was open before, when no tab opens, when the tab holds no new shell (the plugin moved a parked pane of the worktree into it), or when no prompt shows in 30 s, the line does not run. A warning of `create` or a toast of the plugin tells why. The commands run in the shell of the tab, where the user sees them and can stop them.

## Development

The gates are `vp check`, `vp run check:luau`, `vp run test:luau`, `vp run lint:prose` and `vp test --coverage`, with coverage at 100%. `vp run test.mutation` runs the mutation tests. It isolates `HOME`, the Tern config folder and the Tern daemon socket, so no mutant touches the real machine. `vp run smoke` tests the CLI against a Tern session daemon of its own, with its own config folder and socket, so it does not touch the Tern that you use.

`vp run test:luau` runs the Luau tests in `test/luau/` with [lune](https://github.com/lune-org/lune). The tests load `window.luau` and `host.luau` without changes, with the fake `tern` in `test/luau/stub.luau`. Thus, Tern is not necessary for these tests. `vp run check:luau` also checks the types of these tests. Lune is necessary for the types of the `@lune/*` modules.

Homebrew has only lune 0.10.5. Install lune 0.11.0 from the `v0.11.0` release of `lune-org/lune`. Unzip the asset for your platform. Put the `lune` binary on your `PATH`.

`tern plugin types types` refreshes `types/tern.d.luau`.

Tern loads a linked plugin again when a file in its folder changes. Each load drops each pending `cx:pick` and `cx:prompt`: its callback does not run, so the step that waits on it does not start. Thus the plugin code and the Luau tests write no file into the plugin folder. `vp run test.mutation` writes `.stryker-tmp/` and `reports/` in the repository, so a Tern window that has this repository as a linked plugin loads the plugin again and again during a mutation run. For a live test during a mutation run, link a copy of the repository without `.stryker-tmp/` and `reports/`.

`vp run lint:prose` runs vale from `@vvago/vale`. The install script of that package downloads the vale binary from the GitHub API with no token, and shared CI runners hit the limit for calls with no token, so the install failed with HTTP 403. `patches/@vvago%2Fvale@3.24.0.patch` sends `GITHUB_TOKEN` with that download when it is set, and the setup action gives each CI job its token. A vale update needs a new patch: run `bun patch @vvago/vale`, make the same change, and run `bun patch --commit node_modules/@vvago/vale`.

### Releases

The repository uses git flow, with [git-flow-next](https://git-flow.sh/) (`brew install git-flow-next`):

| Branch              | Holds                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `main`              | The released code. This is the default branch, so `tern plugin install` and `setup` get it. |
| `develop`           | The next release. A pull request for a change goes into `develop`.                          |
| `release/<version>` | One release, from `develop`.                                                                |
| `hotfix/<version>`  | One fix of a release, from `main`.                                                          |

A release or a hotfix goes into `main` with a merge commit, and `main` then merges back into `develop`. The tag is the bare version, for example `0.1.0`, with no `v` prefix. The committed `.gitflow` file holds the settings: the branch names, the prefixes, merge commits on finish, and a push after finish. The first `git flow` command in a clone asks to copy `.gitflow` into the local configuration, and `git flow config sync` copies it again.

`main` and `develop` accept a change only through a pull request with green `ci` and `Mutation testing` checks. The ruleset `main and develop` lets the `admin` and `maintain` roles of the repository bypass these rules, so that they can run `git flow release finish`.

To make a release:

1. Start the release branch from `develop`: `git flow release start 0.2.0`.
2. Set `version` in `plugin.toml` to the new version.
3. Add the entry of the new version at the top of `CHANGELOG.md`: `## [0.2.0](https://github.com/riicodespretty/tern-worktrees/releases/tag/0.2.0 "<date>")`.
4. Commit with the subject `chore(release): 🔖 0.2.0`. Push the branch with `git push -u origin release/0.2.0`, and wait for green CI with `gh run watch`. The finish does not wait for CI.
5. Finish: `git flow release finish -m 0.2.0`. It merges the release branch into `main` with a merge commit, tags the merge `0.2.0`, merges `main` back into `develop`, deletes the release branch, and pushes `main`, `develop` and the tag.
6. Publish the GitHub release with the notes of the changelog entry: `gh release create 0.2.0 --verify-tag --title 0.2.0 --notes-file <notes>`.

A hotfix uses the same steps with `git flow hotfix start` and `git flow hotfix finish`. Its branch starts from `main`.

The wiki publishes from `main`, so a wiki edit comes back as a pull request into `main`. The next finish merges it into `develop`.
