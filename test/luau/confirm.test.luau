--!strict

local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local ENV = { TERN_WT_HOME = "/wt", HOME = "/home/u" }
local WORKTREE = "/wt/worktrees/app/feat"
local OTHER = "/wt/worktrees/app/fix"
local FILES = {
	[WORKTREE .. "/.git"] = "gitdir: /src/app/.git/worktrees/feat\n",
	[OTHER .. "/.git"] = "gitdir: /src/app/.git/worktrees/fix\n",
}
local RESOLVED = '{"repos":[{"dir":"/r/app","root":"/r/app","name":"app"}]}'
local BRANCHES = [[{"name":"app","default":"main","branches":["main","x"],"prs":[],"worktrees":[],"warnings":[]}]]
local ELSEWHERE =
	'{"error":{"code":"worktree_exists_elsewhere","message":"elsewhere","existing":"/old/app/x","target":"/wt/worktrees/app/x"}}'

local function argv_lines(plugin: Stub.Harness, verb: string): { string }
	local found: { string } = {}
	for _, run in plugin.runs do
		if run.argv[2] == verb then
			table.insert(found, table.concat(run.argv, " ", 2))
		end
	end
	return found
end

local function item_by_id(request: any, id: string): any
	for _, it in request.opts.items do
		if it.id == id then
			return it
		end
	end
	error("no item " .. id)
end

-- Picks `x` in the branch picker of /r/app and answers its `create` with ELSEWHERE.
local function open_relocate(): (Stub.Harness, any)
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = Stub.load({ env = ENV })
	plugin.commands.new.run(cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	cx.asked[1].next(item_by_id(cx.asked[1], "b:x"), nil, cx)
	plugin:answer("create", ELSEWHERE, 1, cx)
	eq(#cx.asked, 2, "pickers and prompts opened")
	eq(cx.asked[2].kind, "pick", "request kind")
	return plugin, cx
end

-- Presses the close key on the last tab of WORKTREE.
local function close_worktree_tab(): (Stub.Harness, any)
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = WORKTREE .. "/src" } }, 1)
	local plugin = Stub.load({ env = ENV, files = FILES })
	eq(plugin.overrides.close_tab(cx), true, "close_tab result")
	eq(#cx.asked, 1, "pickers and prompts opened")
	eq(cx.asked[1].kind, "pick", "request kind")
	return plugin, cx
end

-- Picks Tear down in the close-tab picker for WORKTREE, then fails its `remove` call with `stdout`.
local function fail_teardown(stdout: string): (Stub.Harness, any)
	local plugin, cx = close_worktree_tab()
	cx.asked[1].next(item_by_id(cx.asked[1], "teardown"), nil, cx)
	plugin:answer("remove", stdout, 1, cx)
	eq(#cx.asked, 2, "pickers and prompts opened")
	eq(cx.asked[2].kind, "pick", "request kind")
	return plugin, cx
end

local DIRTY = (function(): string
	local files: { string } = {}
	for i = 1, 12 do
		table.insert(files, '" M c' .. i .. '"')
	end
	for i = 1, 3 do
		table.insert(files, '"!! i' .. i .. '"')
	end
	return '{"error":{"code":"dirty_worktree","message":"dirty","files":[' .. table.concat(files, ",") .. "]}}"
end)()

test("relocate asks with one Relocate item", function()
	local _, cx = open_relocate()
	local opts = cx.asked[2].opts
	eq(opts.placeholder, "Worktree of this branch is at /old/app/x", "placeholder")
	eq(#opts.items, 1, "items")
	eq(opts.items[1].id, "relocate", "items[1].id")
	eq(opts.items[1].label, "Relocate to …/worktrees/app/x", "items[1].label")
	eq(opts.items[1].icon, "folder", "items[1].icon")
end)

test("dismissing relocate sends no create", function()
	local plugin, cx = open_relocate()
	cx.asked[2].next(nil, nil, cx)
	eq(#argv_lines(plugin, "create"), 0, "create calls")
end)

test("a relocate pick err sends no create", function()
	local plugin, cx = open_relocate()
	cx.asked[2].next(item_by_id(cx.asked[2], "relocate"), "boom", cx)
	eq(#argv_lines(plugin, "create"), 0, "create calls")
end)

test("Relocate sends create with --relocate", function()
	local plugin, cx = open_relocate()
	cx.asked[2].next(item_by_id(cx.asked[2], "relocate"), nil, cx)
	local creates = argv_lines(plugin, "create")
	eq(#creates, 1, "create calls")
	eq(creates[1], "create --repo /r/app --no-tab --branch=x --relocate", "create argv")
end)

test("closing a worktree tab lists Keep worktree first, then Tear down", function()
	local _, cx = close_worktree_tab()
	local opts = cx.asked[1].opts
	eq(opts.placeholder, "Closing worktree tab · …/worktrees/app/feat", "placeholder")
	eq(opts.icon, "branch", "icon")
	eq(#opts.items, 2, "items")
	eq(opts.items[1].id, "keep", "items[1].id")
	eq(opts.items[1].label, "Keep worktree", "items[1].label")
	eq(opts.items[1].detail, "closes the tab, keeps the worktree", "items[1].detail")
	eq(opts.items[2].id, "teardown", "items[2].id")
	eq(opts.items[2].label, "Tear down", "items[2].label")
	eq(opts.items[2].detail, "removes worktree, deletes branch if merged", "items[2].detail")
end)

test("dismissing the close-tab picker sends no remove and keeps the tab", function()
	local plugin, cx = close_worktree_tab()
	cx.asked[1].next(nil, nil, cx)
	eq(#argv_lines(plugin, "remove"), 0, "remove calls")
	eq(#cx.commands, 0, "commands run")
end)

test("Keep worktree closes the tab and sends no remove", function()
	local plugin, cx = close_worktree_tab()
	cx.asked[1].next(item_by_id(cx.asked[1], "keep"), nil, cx)
	eq(#argv_lines(plugin, "remove"), 0, "remove calls")
	eq(#cx.commands, 1, "commands run")
	eq(cx.commands[1], "close_tab", "command")
end)

test("Tear down sends remove <path> --keep-tab", function()
	local plugin, cx = close_worktree_tab()
	cx.asked[1].next(item_by_id(cx.asked[1], "teardown"), nil, cx)
	local removes = argv_lines(plugin, "remove")
	eq(#removes, 1, "remove calls")
	eq(removes[1], "remove " .. WORKTREE .. " --keep-tab", "remove argv")
	eq(#cx.commands, 0, "commands run before remove ends")
end)

test("a pick err while closing a tab still closes the tab", function()
	local plugin, cx = close_worktree_tab()
	cx.asked[1].next(nil, "boom", cx)
	eq(#argv_lines(plugin, "remove"), 0, "remove calls")
	eq(cx.commands[1], "close_tab", "command")
end)

test("a pick err with Tear down picked keeps the worktree and closes the tab", function()
	local plugin, cx = close_worktree_tab()
	cx.asked[1].next(item_by_id(cx.asked[1], "teardown"), "boom", cx)
	eq(#argv_lines(plugin, "remove"), 0, "remove calls")
	eq(cx.commands[1], "close_tab", "command")
end)

test("a closed tab with two worktrees asks twice, and Escape keeps both", function()
	local live = Stub.cx({
		{ pane = 1, tab = 1, cwd = WORKTREE },
		{ pane = 2, tab = 1, cwd = OTHER },
	}, 1)
	local plugin = Stub.load({ env = ENV, files = FILES })
	plugin.handlers.window_start(live)
	local cx = Stub.cx({ { pane = 3, tab = 2, cwd = "/tmp" } }, 3)
	plugin.handlers.tab_closed({ tab = 1 }, cx)
	eq(#cx.asked, 1, "pickers and prompts opened")
	eq(cx.asked[1].opts.placeholder, "Worktree tab closed · …/worktrees/app/feat", "placeholder")
	eq(cx.asked[1].opts.items[1].id, "keep", "items[1].id")
	cx.asked[1].next(nil, nil, cx)
	eq(#cx.asked, 2, "pickers and prompts opened")
	eq(cx.asked[2].kind, "pick", "request kind")
	eq(cx.asked[2].opts.placeholder, "Worktree tab closed · …/worktrees/app/fix", "placeholder")
	cx.asked[2].next(nil, nil, cx)
	eq(#argv_lines(plugin, "remove"), 0, "remove calls")
	eq(#cx.commands, 0, "commands run")
end)

test("Keep worktree in the Worktree tab closed picker says only that it keeps the worktree", function()
	local live = Stub.cx({ { pane = 1, tab = 1, cwd = WORKTREE } }, 1)
	local plugin = Stub.load({ env = ENV, files = FILES })
	plugin.handlers.window_start(live)
	local cx = Stub.cx({ { pane = 3, tab = 2, cwd = "/tmp" } }, 3)
	plugin.handlers.tab_closed({ tab = 1 }, cx)
	eq(cx.asked[1].opts.items[1].id, "keep", "items[1].id")
	eq(cx.asked[1].opts.items[1].detail, "keeps the worktree", "items[1].detail")
end)

test("a failed teardown toasts the files, ignored ones first in the 10", function()
	local _, cx = fail_teardown(DIRTY)
	local toast = cx.toasts[#cx.toasts]
	local cause = "15 files with work to lose:  M c1,  M c2,  M c3,  M c4,  M c5,  M c6,  M c7; "
		.. "ignored, hard to rebuild: i1, i2, i3; and 5 more"
	eq(toast.level, "error", "toast level")
	eq(toast.title, "Teardown failed: " .. cause, "toast title")
	eq(toast.detail, nil, "toast detail")
	local opts = cx.asked[2].opts
	eq(opts.placeholder, "Teardown failed: " .. cause, "placeholder")
	eq(#opts.items, 2, "items")
	eq(opts.items[1].id, "retry", "items[1].id")
	eq(opts.items[1].label, "Retry", "items[1].label")
	eq(opts.items[2].id, "force", "items[2].id")
	eq(opts.items[2].label, "Force delete", "items[2].label")
	eq(opts.items[2].detail, "discards uncommitted work", "items[2].detail")
end)

test("the failed-teardown picker names the file that stops the teardown, not the worktree path", function()
	local _, cx = fail_teardown(
		'{"error":{"code":"dirty_worktree","message":"'
			.. WORKTREE
			.. ' has work that removing it would lose","existing":"'
			.. WORKTREE
			.. '","files":["?? .setup-ran"]}}'
	)
	local toast = cx.toasts[#cx.toasts]
	eq(toast.title, "Teardown failed: 1 file with work to lose: ?? .setup-ran", "toast title")
	eq(toast.detail, nil, "toast detail")
	local placeholder = cx.asked[2].opts.placeholder
	eq(placeholder, "Teardown failed: 1 file with work to lose: ?? .setup-ran", "placeholder")
	eq(string.find(placeholder, "/", 1, true), nil, "a slash in the placeholder")
end)

test("a failed teardown names the worktree by its folder in the git message and keeps the saved files path", function()
	local _, cx = fail_teardown(
		'{"error":{"code":"git_failed","message":"fatal: \''
			.. WORKTREE
			.. '\' is locked","staging":"'
			.. WORKTREE
			.. '.carry"}}'
	)
	local cause = "fatal: 'feat' is locked · Saved files: …/worktrees/app/feat.carry"
	eq(cx.toasts[#cx.toasts].title, "Teardown failed: " .. cause, "toast title")
	eq(cx.asked[2].opts.placeholder, "Teardown failed: " .. cause, "placeholder")
end)

test("Retry sends remove again", function()
	local plugin, cx = fail_teardown(DIRTY)
	cx.asked[2].next(item_by_id(cx.asked[2], "retry"), nil, cx)
	local removes = argv_lines(plugin, "remove")
	eq(#removes, 1, "remove calls")
	eq(removes[1], "remove " .. WORKTREE .. " --keep-tab", "remove argv")
end)

test("Force delete sends remove with --force", function()
	local plugin, cx = fail_teardown(DIRTY)
	cx.asked[2].next(item_by_id(cx.asked[2], "force"), nil, cx)
	local removes = argv_lines(plugin, "remove")
	eq(#removes, 1, "remove calls")
	eq(removes[1], "remove " .. WORKTREE .. " --keep-tab --force", "remove argv")
end)

test("Force delete shows a deleting toast, then a Deleted worktree toast", function()
	local plugin, cx = fail_teardown(DIRTY)
	table.clear(cx.toasts)
	cx.asked[2].next(item_by_id(cx.asked[2], "force"), nil, cx)
	eq(#cx.toasts, 1, "toasts while remove runs")
	eq(cx.toasts[1].level, "info", "deleting toast level")
	eq(cx.toasts[1].title, "Deleting worktree feat…", "deleting toast title")
	plugin:answer("remove", '{"removed":"' .. WORKTREE .. '","warnings":[]}', 0, cx)
	eq(#cx.toasts, 2, "toasts after remove answers")
	eq(cx.toasts[2].level, "success", "done toast level")
	eq(cx.toasts[2].title, "Deleted\u{A0}worktree", "done toast title")
end)

test("dismissing the failed teardown sends nothing and keeps the tab", function()
	local plugin, cx = fail_teardown(DIRTY)
	cx.asked[2].next(nil, nil, cx)
	eq(#plugin.runs, 0, "CLI calls")
	eq(#cx.commands, 0, "commands run")
end)

test("a failed-teardown pick err with Force delete picked sends nothing", function()
	local plugin, cx = fail_teardown(DIRTY)
	cx.asked[2].next(item_by_id(cx.asked[2], "force"), "boom", cx)
	eq(#plugin.runs, 0, "CLI calls")
	eq(#cx.commands, 0, "commands run")
end)

test("a failed-teardown pick err with Retry picked sends nothing", function()
	local plugin, cx = fail_teardown(DIRTY)
	cx.asked[2].next(item_by_id(cx.asked[2], "retry"), "boom", cx)
	eq(#plugin.runs, 0, "CLI calls")
	eq(#cx.commands, 0, "commands run")
end)

runner.finish()
