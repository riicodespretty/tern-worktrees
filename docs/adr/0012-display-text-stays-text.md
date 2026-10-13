# ADR-0012: Display text from the CLI stays text

Status: Accepted

## Decision

The CLI gives no typed fields for the `setup not run:` and `tab not opened:` causes. The plugin keeps the copy from `sentence_case(res.status)` and the short `label: message` form of warnings. The `Creating` or `Reusing worktree` verb of the toast that shows while `create` runs stays a guess of the plugin, not a field of the CLI answer.

## Why

- The plugin always passes `--no-tab` and does not parse the setup text of the CLI, so no code parses these causes (#54, Out of scope, C2 spec §2 d).
- The status copy and the warning form are display text only. README.md and SKILL.md give them (#54, C2 spec §2 c, f).
- That toast shows while the CLI runs, before the answer comes (#54, C3 spec claim 7). T7 of #54 fixed the input of the guess.

## Reopen when

- The plugin stops passing `--no-tab`.
- The plugin must select a step from one of these causes.
