--!strict

local Stub = require("./stub")
local harness = require("./harness")
local test, eq = harness.test, harness.eq

local WORKTREE = "/wt/worktrees/app/feat"

test("close_tab asks once for the last tab on a managed worktree", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = WORKTREE .. "/src" } }, 1)
	local h = Stub.load({
		env = { TERN_WT_HOME = "/wt", HOME = "/home/u" },
		files = { [WORKTREE .. "/.git"] = "gitdir: /src/app/.git/worktrees/feat\n" },
	})
	eq(h.overrides.close_tab(cx), true, "close_tab result")
	eq(#cx.asked, 1, "dialogs opened")
	eq(cx.asked[1].kind, "pick", "dialog kind")
end)

test("close_tab leaves a worktree of another repository alone", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = WORKTREE .. "/src" } }, 1)
	local h = Stub.load({
		env = { TERN_WT_HOME = "/wt", HOME = "/home/u" },
		files = { [WORKTREE .. "/.git"] = "gitdir: /src/other/.git/worktrees/feat\n" },
	})
	eq(h.overrides.close_tab(cx), false, "close_tab result")
	eq(#cx.asked, 0, "dialogs opened")
end)

test("close_tab leaves a worktree that a pane of another tab still uses", function()
	local cx = Stub.cx({
		{ pane = 1, tab = 1, cwd = WORKTREE .. "/src" },
		{ pane = 2, tab = 2, cwd = WORKTREE },
	}, 1)
	local h = Stub.load({
		env = { TERN_WT_HOME = "/wt", HOME = "/home/u" },
		files = { [WORKTREE .. "/.git"] = "gitdir: /src/app/.git/worktrees/feat\n" },
	})
	eq(h.overrides.close_tab(cx), false, "close_tab result")
	eq(#cx.asked, 0, "dialogs opened")
end)

test("window_start learns the worktree root from list", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app/feat" } }, 1)
	local h = Stub.load({
		env = { HOME = "/home/u" },
		files = { ["/r/app/feat/.git"] = "gitdir: /src/app/.git/worktrees/feat\n" },
	})
	h.handlers.window_start(cx)
	h:answer("list", '{"root":"/r/","worktrees":[]}')
	eq(h.kv.worktreeRoot, "/r", "remembered worktree root")
	eq(h.overrides.close_tab(cx), true, "close_tab result")
	eq(#cx.asked, 1, "dialogs opened")
end)

harness.finish()
