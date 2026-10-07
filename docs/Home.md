# tern-worktrees

`tern-worktrees` shows git worktrees as Tern tabs. This page tells how the plugin works and why. Install and usage are in the [README](https://github.com/riicodespretty/tern-worktrees/blob/main/README.md), and the terms are in the [glossary](GLOSSARY.md).

| Doc                     | What it holds                         |
| ----------------------- | ------------------------------------- |
| [Home](Home.md)         | The design, and why it replaces Orca. |
| [Glossary](GLOSSARY.md) | The domain terms.                     |

## Why worktrees move from Orca to Tern

Before this plugin, Orca made the worktrees and showed each one in its own app. The user works in the terminal in Tern, so each worktree was in two apps, with two lists of open work. With this plugin, Tern opens each worktree as a tab in the session of its repository, and closing the tab asks to tear the worktree down. Agents use the same `tern-wt` CLI, so a worktree that an agent makes is a tab that the user sees.

A branch can still have an Orca worktree. When the user picks that branch, the plugin offers to relocate the worktree into the worktree root. After a relocation, Orca shows the previous path as missing. The plugin does not change the Orca data.

## Architecture

The design has three parts:

- `tern-wt`, a Bun and TypeScript CLI in `src/`, the single implementation. Each git and gh step runs in the CLI.
- The window half of the plugin, `window.luau`, a thin UI over the CLI. It opens the dialog block, turns each answer into a CLI call, and keeps each worktree tab matched to its worktree.
- The dialog block, in `host.luau`, a floating block that shows a picker, a confirmation or a text prompt.

The omp skill and the Carly exports give agents the same CLI, so the user and the agents get the same behavior.

### The CLI

Each command prints one JSON object, and each failure has an error code. The window half reads the code to select its next step. For example, `worktree_exists_elsewhere` opens the Relocate dialog. The CLI uses only `node:` built-in modules, so Bun runs it from source and Vitest tests the same files.

`branches` lists the local branches and the branches on `origin`, each one time, newest commit first.

### The dialog block

The window half opens the dialog block with a request: a pick, a confirmation or a prompt. The dialog floats over the layout. When it cannot float, it stays docked adjacent to the active pane, and it works the same.

The block gives its answer through its pane title. After the user answers, the title changes to `twt:<request id>:<answer as JSON>`. The window half listens for `title` events, decodes the answer of its pending request, closes the dialog and goes on. When the user closes the dialog, the window half reads that as Cancel.

### Pickers and sessions

When the hotkey runs, the window half sends the working directory of each pane to `tern-wt resolve`, which gives the repository root of each one. The current session gets the branch picker of its repository, else the repo picker opens. A new worktree tab opens in the session of its repository, else in a new session. When `resolve` fails, the picker still opens. When the root of a repository is unknown, that repository matches no session.

### Close interception

Each tab with a pane in a managed worktree is a worktree tab. The window half keeps a map from each tab to its worktree, and updates it when a tab or pane opens or a working directory changes. Two paths catch the close of a worktree tab:

- The `close_tab` and `close_pane` overrides catch the close keys before the tab closes. The dialog offers Tear down, Keep worktree and Cancel. The tab closes only after the teardown succeeds, so Cancel keeps the tab and the worktree.
- The `tab_closed` event catches the other closes, for example the × on the tab bar or `tern close`. At that time the tab is closed, so the dialog offers Tear down and Keep worktree only.

A tab that shares its worktree with a different open tab closes with no dialog. `tern-wt remove` removes the worktree before it closes the tabs, so an agent teardown shows no dialog.

When a teardown fails, the dialog offers Retry, Force delete and Cancel.

## Development

The gates are `vp check`, `vp run check:luau`, `vp run lint:prose` and `vp test --coverage`, with coverage at 100%. `vp run test.mutation` runs the mutation tests. It isolates `HOME`, the Tern config folder and the Tern daemon socket, so no mutant touches the real machine. `vp run smoke` tests the CLI against the running Tern window.
