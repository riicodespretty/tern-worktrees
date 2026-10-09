# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `riicodespretty/tern-worktrees`. Use the `gh` CLI for each operation.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Pass a long body through a here-document.
- **Read an issue**: `gh issue view <number> --comments`. Filter the comments with `jq` and fetch the labels too.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`. Add `--label` and `--state` filters as needed.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Add or remove a label**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Run `gh` in a clone of the repo. It reads the repo from `git remote -v`.

## Pull requests are not a request surface

**PRs as a request surface: no.** The triage skill reads this flag. Pull requests do not enter the triage queue. Only issues do.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the ticket"

Run `gh issue view <number> --comments`.

## Map and ticket operations

The wayfinder skill uses these. The **map** is one issue. Its **children** are the tickets.

- **Map**: issue #1, labelled `wayfinder:map`. Its body has these headings: `Destination`, `Notes`, `Decisions so far`, `Not yet specified`, `Out of scope` and `Resolutions`.
- **Child ticket**: a sub-issue of the map. Add it with `gh api` on the sub-issues endpoint. It has one label, `wayfinder:<type>`. The type is `research`, `prototype`, `grilling` or `task`. For example, #17 has `wayfinder:task`. After the claim, the driving dev is the assignee.
- **Blocking**: GitHub native issue dependencies. Add an edge with `gh api --method POST repos/riicodespretty/tern-worktrees/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. The `<blocker-db-id>` is the numeric database id of the blocker. Get it with `gh api repos/riicodespretty/tern-worktrees/issues/<n> --jq .id`. It is not the `#number` and not the `node_id`. GitHub reports `issue_dependencies_summary.blocked_by`. It counts open blockers only. A ticket is unblocked when all blockers are closed.
- **Frontier query**: list the open children of the map. Drop each child that has an open blocker or an assignee. The first child in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`. This is the first write of a session.
- **Resolve**: post the answer with `gh issue comment <n> --body "<answer>"`. Then run `gh issue close <n>`. Then add a line to `## Decisions so far` in the map body. The line links the ticket and states the answer.
