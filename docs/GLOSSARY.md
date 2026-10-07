# tern-worktrees

Git worktrees shown as Tern tabs, for the user and for agents, without Orca.

## Language

### Worktrees

**Worktree root**:
The directory where the plugin makes worktrees, one folder for each repository.
_Avoid_: Workspace, worktree dir

**Managed worktree**:
A worktree in the worktree root.
_Avoid_: Tern worktree, own worktree

**Worktree tab**:
A Tern tab with its panes in a managed worktree.
_Avoid_: Branch tab

**Relocate**:
To move the worktree of a branch into the worktree root from a directory that is not in the root. The worktree then is a managed worktree.
_Avoid_: Adopt, migrate, import

### Teardown

**Teardown**:
The removal of a managed worktree and, as the teardown policy says, of its branch.
_Avoid_: Cleanup, delete, close

**Teardown policy**:
The rule that tells a teardown what to do with the branch: keep it, delete it when merged, or delete it.
_Avoid_: Delete mode, cleanup policy

**Force delete**:
A teardown that discards the uncommitted work in the worktree.
_Avoid_: Force remove, hard delete

### Repositories and settings

**Clone root**:
The directory that holds the clones of GitHub repositories, one folder for each owner.
_Avoid_: Projects dir, code root

**Options file**:
The file of user settings for the plugin: the teardown policy, the clone root and the hotkeys.
_Avoid_: Config, settings file

**Repo picker**:
The list from which the user selects a repository: one open in a session, one on GitHub, or a new one.
_Avoid_: Project picker

**Branch picker**:
The list of the branches and pull requests of one repository. The user selects one, or types the name of a new branch.
_Avoid_: Worktree picker
