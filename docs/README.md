# tern-worktrees

`tern-worktrees` shows git worktrees as Tern tabs. This page tells how the plugin works and why. Install and usage are in the [README](https://github.com/riicodespretty/tern-worktrees/blob/main/README.md), and the terms are in the [glossary](GLOSSARY.md). Agents read three more docs: the [issue tracker](agents/issue-tracker.md), the [domain docs](agents/domain.md) and the [triage labels](agents/triage-labels.md).

## Why worktrees move from Orca to Tern

Before this plugin, Orca made the worktrees and showed each one in its own app. The user works in the terminal in Tern, so each worktree was in two apps, with two lists of open work. With this plugin, Tern opens each worktree as a tab in the session of its repository, and closing the tab asks to tear the worktree down. Agents use the same `tern-wt` CLI, so a worktree that an agent makes is a tab that the user sees.

A branch can still have an Orca worktree. When the user picks that branch, the plugin offers to relocate the worktree into the worktree root. After a relocation, Orca shows the previous path as missing. The plugin does not change the Orca data.

## Architecture

The design has three parts:

- `tern-wt`, a Bun and TypeScript CLI in `src/`, the single implementation. Each git and gh step runs in the CLI.
- The window half of the plugin, `window.luau`, a thin UI over the CLI. It opens the dialog block, turns each answer into a CLI call, and keeps each worktree tab matched to its worktree. It also keeps the worktree rows of the command palette current.
- The dialog block, in `host.luau`, a floating block that shows a picker, a confirmation or a text prompt.

The omp skill and the Carly exports give agents the same CLI, so the user and the agents get the same behavior.

### The CLI

Each command prints one JSON object, and each failure has an error code. The window half reads the code to select its next step. For example, `worktree_exists_elsewhere` opens the Relocate dialog. The CLI uses only `node:` built-in modules, so Bun runs it from source and Vitest tests the same files.

`branches` lists the local branches and the branches on `origin`, each once, newest commit first. `branches --offline` reads only local refs: no fetch, no pull request list and no GitHub lookup of the default branch. The worktree rows use it, so most of their refreshes cost no network traffic.

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

### The dialog block

The window half opens the dialog block with a request: a pick, a confirmation or a prompt. The dialog floats over the layout. When it cannot float, it stays docked adjacent to the active pane, and it works the same.

The dialog reuses the classes of the Tern command palette card (`cmdk tn-cmdk`), and the Tern classes `mdl`, `btn`, `kbd` and `ck-foot`. `styles.css` gets its colors, font families and easing from the Tern theme variables. Where Tern has no variable, it copies the value from the Tern theme rule on `body`, the palette rules, or the overlay rules (`.tn-pl-*`). Some values are the plugin's own: the focus ring and the gap of the key hints. The prompt head copies the size and the offsets of the picker head, so the card keeps its shape when a picker gives way to a prompt. Thus the dialog opens where the palette opens, and it uses the Tern theme colors, fonts, font size and interface style. Two differences stay. Picker rows keep the fixed pitch of the picker element, 36 pixels, where palette rows are 40 pixels. In the studio layout, the prompt input has no box, where the palette input is a pill. Each dialog shows paths in a short form:

- `~` for the home folder.
- `…/worktrees/…` for a worktree root that is not in the home folder.
- A cut in the middle of a long path.

Apart from those two differences, the dialog follows the palette where the picker element is not the same as it. A selected row has the accent edge of the palette. No row moves when the query changes or the selection moves, because these changes come at each key press. The clear button of an empty picker shows no key, because Escape cancels the dialog. A confirmation with a danger button gets the red glow of a Tern danger dialog. The key hint on an accent button has the color of its label: a Tern rule paints it white, and white is almost invisible on the light accent fill of the dark theme.

A picker moves its selection as the palette does. Up and Down wrap at the ends. Home and End go to the first and the last row, and Page Up and Page Down move 8 rows. Tab goes to the first row of the next group, and Shift+Tab to the first row of the previous group. A change to the query selects the top row. One click picks a row, the same as Enter.

The palette moves its selection to the row below the pointer, and the picker cannot do that. In Tern 0.5.3, the `event` handler of the dialog gets a `select` for a click, but no event when the pointer moves over the rows. Thus the selection of the keys stays on its row, and Enter picks that row, not the row below the pointer. After a navigation key moves the selection, the card gets the class `twt-keyed`. A row below the pointer then gets a thin ring and no fill, so it looks different from the selected row. A change to the query, or the clear button, removes the class, because these changes move the selection back to the top row.

The second click of a double-click can come after the next dialog opens, and that dialog opens in less than 50 ms. Thus a dialog ignores clicks for its first 500 ms.

When the query and the selection change together, the Tern picker keeps `aria-selected` on the row that the user selected before. The page shows one selection bar, but a screen reader can find two selected rows.

A screen reader reads each confirmation button by its label alone: the key hint has `aria-hidden`, and `aria-keyshortcuts` on the button names the key.

The Teardown failed dialog lists at most 10 files with work to lose. It gives the hard-to-rebuild files first claim on the 10 lines, and the changes use the lines that are left. The dialog shows the changes first, then a heading, then the hard-to-rebuild files. If the dialog cannot show all files, the last line gives the number of files that it does not show.

A floating pane comes with a frame: a title bar, a border and a background. The float has no attribute that names its pane, and the Tern CSS engine rejects `:has()`, so no static rule can pick out the dialog. The window half installs `dialog-float.css` with `tern.css` while a dialog waits for an answer, and clears the sheet when the last dialog ends. It also clears the sheet at load, so a reload removes a sheet that the previous plugin left.

A reload of the window half loses the record of each dialog that waits for an answer, but the dialog block keeps running. At the first event, hotkey or close key after a load, the window half closes each dialog pane that no request of its own waits on. A close key that hits such a pane only closes it. When a stale dialog gives an answer before that, the window half closes its pane and drops the answer. When the window half fails to load, for example when its `load` goes over the 50 ms budget of Tern, no handler of the plugin runs in that window until the next reload. A dialog that waits at that time stays open after its answer. The × of its pane closes it.

The sheet removes the frame from each floating pane. Thus a float that the user opened also shows with no frame until the last dialog ends. The rules use Tern-internal classes, for example `section.tn-pane.pip` and `tn-head`. When a Tern update renames them, the dialog shows with its frame again. When the plugin cannot read the file, it installs no sheet.

The block gives its answer through its pane title. After the user answers, the title changes to `twt:<request id>:<answer as JSON>`. The window half listens for `title` events, decodes the answer of its pending request, closes the dialog and goes on. When the user closes the dialog, the window half reads that as Cancel.

The title protocol has a fixed set of names:

- The modes of a request are `pick`, `confirm` and `prompt`.
- The actions of an answer are `select`, `new`, `button`, `text` and `cancel`.
- The `kind` value `cancel` on a button changes its key hint to `esc` and moves the button to the left end of the footer. The dialog then drops its own `esc` hint.
- The `key` value of a button is `backspace` or `cmd+backspace`. It gives the button the key hint `⌫` or `⌘⌫`, and that key presses the button.

A click on a button, Enter for the first button, or the `key` of a button gives the `button` action with the id of that button. A button after the first, with no `kind` of `cancel` and no `key`, has no key hint. Escape or a close gives the `cancel` action.

Tern binds `cmd+backspace` to the delete-line code of the terminal (`text:\x15`), and the bindings of the window get each key before a block does. Thus the dialog gets `ctrl+u` when the user presses `cmd+backspace` (seen on Tern 0.5.3). A plugin cannot change a default binding, so the dialog reads `ctrl+u` as `cmd+backspace`. A `ctrl+u` that the user presses also presses that button.

`window.luau` and `host.luau` each hold a copy of these names and the `twt:` prefix, so the copies must match. A changed action name reads as Cancel in `parse_answer`. A changed prefix makes the window half ignore the answer, so the dialog keeps waiting.

The request types follow the same rule. `host.luau` holds the full request types (`PickRequest`, `ConfirmRequest` and `PromptRequest`). The payload that the window half sends is a subset of these types. `window.luau` holds the types of that payload (`PickDialog`, `ConfirmDialog` and `PromptDialog`), and it does not add the fields that only the host uses. A field can be mandatory in the window half and optional in the host. The field names and their base value types (`string`, `{ Item }` and `{ Button }`) must match in the two files. `ConfirmDialog` also has the window-only field `reveal`, because it comes from `ConfirmOptions`. The `confirm` function gives `reveal` to `ask` and removes it before it sends the request, so the payload has no `reveal`.

### Pickers and sessions

When the hotkey runs, the window half sends the working directory of each pane to `tern-wt resolve`, which gives the repository root of each one. The current session gets the branch picker of its repository, else the repo picker opens. A new worktree tab opens in the session of its repository, else in a new session. When `resolve` fails, the picker still opens. When the root of a repository is unknown, that repository matches no session.

While a dialog waits in the current session, the hotkey opens no second picker. It focuses that dialog. A dialog in a different session does not block the hotkey. When the user presses the hotkey again before a picker opens, the newest press wins: the `resolve` and `branches` calls of the older presses end with no picker, so one picker opens, and no picker opens after the user closes it.

### Close interception

Each tab with a pane in a managed worktree is a worktree tab. The window half keeps a map from each tab to its worktree. It updates the map when a tab or pane opens, or when a working directory changes. Two paths catch the close of a worktree tab:

- The `close_tab` and `close_pane` overrides catch the close keys before the tab closes. The dialog has the title "Closing a worktree tab" and offers Keep worktree (Enter), Tear down (`⌫`) and Cancel (Escape). The tab closes after Keep worktree, or after the teardown succeeds, so Cancel keeps the tab and the worktree.
- The `tab_closed` event catches the other closes in the window, for example the tab bar or the tab menu. At that time the tab is closed, so the dialog has the title "Worktree tab closed" and offers Keep worktree and Tear down only.

A close through the CLI, for example `tern close <block>`, sends no event to the window half: no `pane_closed` and no `tab_closed` (seen on Tern 0.5.3). That tab closes with no dialog, and the worktree stays on disk until `tern-wt remove` tears it down.

A tab that shares its worktree with a different open tab closes with no dialog. `tern-wt remove` removes the worktree before it closes the tabs, so an agent teardown shows no dialog.

When a teardown fails, the dialog offers Retry (Enter), Force delete (`⌘⌫`) and Cancel (Escape). Tear down and Force delete are the two steps of a removal: Tear down stops when the worktree has work to lose, and only Force delete discards that work.

## Development

The gates are `vp check`, `vp run check:luau`, `vp run lint:prose` and `vp test --coverage`, with coverage at 100%. `vp run test.mutation` runs the mutation tests. It isolates `HOME`, the Tern config folder and the Tern daemon socket, so no mutant touches the real machine. `vp run smoke` tests the CLI against a Tern session daemon of its own, with its own config folder and socket, so it does not touch the Tern that you use.

`vp run lint:prose` runs vale from `@vvago/vale`. The install script of that package downloads the vale binary from the GitHub API with no token, and shared CI runners hit the limit for calls with no token, so the install failed with HTTP 403. `patches/@vvago%2Fvale@3.24.0.patch` sends `GITHUB_TOKEN` with that download when it is set, and the setup action gives each CI job its token. A vale update needs a new patch: run `bun patch @vvago/vale`, make the same change, and run `bun patch --commit node_modules/@vvago/vale`.
