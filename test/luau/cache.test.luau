--!strict

local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local REPO = "/r/app"
local ENV = { TERN_WT_HOME = "/wt", HOME = "/home/u" }
local RESOLVED = '{"repos":[{"dir":"/r/app","root":"/r/app","name":"app"}]}'
local BRANCHES = [[{"name":"app","default":"main","branches":["main","x"],
"prs":[{"number":7,"title":"Fix login","branch":"fix-login"}],
"worktrees":[{"branch":"x","path":"/wt/worktrees/app/x"}],"warnings":[]}]]
local UPDATED = [[{"name":"app","default":"main","branches":["main","x","y"],"prs":[],
"worktrees":[{"branch":"y","path":"/wt/worktrees/app/y"}],"warnings":[]}]]
local STALE = [[{"name":"app","default":"main","branches":["main"],"prs":[],"worktrees":[],"warnings":[]}]]
local OFFLINE = [[{"name":"app","default":"dev","branches":["main","x","y"],"prs":[],
"worktrees":[{"branch":"y","path":"/wt/worktrees/app/y"}],"warnings":[]}]]
local FAILED = '{"error":{"code":"git_failed","message":"fetch failed"}}'
local PR_LIST_FAILED = [[{"name":"app","default":"main","branches":["main","x","y"],"prs":[],
"worktrees":[{"branch":"y","path":"/wt/worktrees/app/y"}],"warnings":["pr list failed: gh auth"]}]]
local SAME_PR_LIST_FAILED = [[{"name":"app","default":"main","branches":["main","x"],"prs":[],
"worktrees":[{"branch":"x","path":"/wt/worktrees/app/x"}],"warnings":["pr list failed: gh auth"]}]]
local LOADING = "info Loading branches…"
local REFRESHING = "info Refreshing branches…"
local CHANGED = "info Branches refreshed: reopen to see changes"
local UNCHANGED = "info Branches refreshed: no changes"
local CREATED =
	'{"branch":"y","carried":[],"path":"/wt/worktrees/app/y","repo":"/r/app","status":"created","warnings":[]}'

local function argv_lines(plugin: Stub.Harness, verb: string): { string }
	local found: { string } = {}
	for _, run in plugin.runs do
		if run.argv[2] == verb then
			table.insert(found, table.concat(run.argv, " ", 2))
		end
	end
	return found
end

-- Takes the pending `branches` runs out of the fake CLI, as a callback that Tern drops, and returns them.
local function drop_branches(plugin: Stub.Harness): { Stub.Run }
	local dropped: { Stub.Run } = {}
	for i = #plugin.runs, 1, -1 do
		if plugin.runs[i].argv[2] == "branches" then
			table.insert(dropped, table.remove(plugin.runs, i) :: Stub.Run)
		end
	end
	return dropped
end

local function item_by_id(request: any, id: string): any?
	for _, it in request.opts.items do
		if it.id == id then
			return it
		end
	end
	return nil
end

local function item_ids(request: any): string
	local ids: { string } = {}
	for _, it in request.opts.items do
		table.insert(ids, it.id .. (if it.detail == "worktree" then "*" else ""))
	end
	return table.concat(ids, " ")
end

-- The toasts of the branch picker cache so far, the ones with "branch" in the title, each as its level and title,
-- joined by "; ". A create also shows its own toast.
local function toast_lines(cx: any): string
	local lines: { string } = {}
	for _, t in cx.toasts do
		if string.find(string.lower(t.title), "branch", 1, true) then
			table.insert(lines, t.level .. " " .. t.title)
		end
	end
	return table.concat(lines, "; ")
end

-- A window with pane 1 in REPO and `git.auto_fetch_minutes` 0, so the worktree rows run only `branches --offline`.
local function window(): (Stub.Harness, any)
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = REPO } }, 1)
	cx.layout.new_tab = function(_self: any, _opts: any): number?
		return nil
	end
	cx.settings = {
		get = function(_self: any, _key: string): any
			return 0
		end,
	}
	return Stub.load({ env = ENV }), cx
end

-- The `branches` calls that are pending, online and offline.
local function branches_calls(plugin: Stub.Harness): (number, number)
	local online, offline = 0, 0
	for _, line in argv_lines(plugin, "branches") do
		if string.find(line, "--offline", 1, true) then
			offline += 1
		else
			online += 1
		end
	end
	return online, offline
end

-- Presses the new-worktree hotkey and answers its `resolve`. Returns how many pickers and prompts are open.
local function open(plugin: Stub.Harness, cx: any): number
	plugin.commands.new.run(cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	return #cx.asked
end

-- Opens the branch picker a first time, which waits for `branches` and answers it with `stdout`. Checks the loading
-- toast, then clears the toasts.
local function first_open(plugin: Stub.Harness, cx: any, stdout: string)
	eq(open(plugin, cx), 0, "pickers before branches answers on the first open")
	eq(#argv_lines(plugin, "branches"), 1, "branches calls on the first open")
	plugin:answer("branches", stdout, 0, cx)
	eq(#cx.asked, 1, "pickers after the first open")
	eq(toast_lines(cx), LOADING, "toasts after the first open")
	table.clear(cx.toasts)
end

test("the first open shows a loading toast while branches runs", function()
	local plugin, cx = window()
	open(plugin, cx)
	eq(toast_lines(cx), LOADING, "toasts while the first branches runs")
	open(plugin, cx)
	eq(toast_lines(cx), LOADING, "toasts after a second press during the first branches")
	plugin:answer("branches", BRANCHES, 0, cx)
	eq(#cx.asked, 1, "pickers after branches answers")
	eq(toast_lines(cx), LOADING, "toasts after branches answers")
end)

test("a cached open shows a refreshing toast", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	eq(open(plugin, cx), 2, "pickers after the second open")
	eq(toast_lines(cx), REFRESHING, "toasts after the second open")
end)

test("a background branches that changes the picker toasts to reopen it", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	plugin:answer("branches", UPDATED, 0, cx)
	eq(toast_lines(cx), REFRESHING .. "; " .. CHANGED, "toasts after the refresh")
end)

test("a background branches with the same picker toasts no changes", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	eq(toast_lines(cx), REFRESHING .. "; " .. UNCHANGED, "toasts after the refresh")
end)

test("a background branches compares after it keeps the cached pull requests", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	plugin:answer("branches", SAME_PR_LIST_FAILED, 0, cx)
	eq(toast_lines(cx), REFRESHING .. "; " .. UNCHANGED, "toasts after the refresh")
end)

test("a second press during a background branches shows one loading and one finish toast", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	eq(open(plugin, cx), 3, "pickers after the third press")
	eq(toast_lines(cx), REFRESHING, "toasts after the third press")
	plugin:answer("branches", UPDATED, 0, cx)
	eq(toast_lines(cx), REFRESHING .. "; " .. CHANGED, "toasts after the refresh")
	plugin:answer("branches", UPDATED, 0, cx)
	eq(toast_lines(cx), REFRESHING .. "; " .. CHANGED, "toasts after the rerun")
end)

test("refreshes after a create or a teardown show no toasts", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	cx.asked[1].next(item_by_id(cx.asked[1], "b:x"), nil, cx)
	plugin:answer("create", CREATED, 0, cx)
	plugin:answer("branches", OFFLINE, 0, cx)
	local call = { reply = function(_self: any, _res: any) end, fail = function(_self: any, _err: string) end }
	function call.wait(_self: any, _ms: number): any
		return nil
	end
	plugin.exports.remove("/wt/worktrees/app/x", nil, cx, call)
	plugin:answer("remove", '{"removed":"/wt/worktrees/app/x","branch":"x","warnings":[]}', 0, cx)
	plugin:answer("branches", STALE, 0, cx)
	eq(toast_lines(cx), "", "toasts after the create and the teardown")
end)

test("a second open shows the cached picker before branches answers", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	eq(open(plugin, cx), 2, "pickers after the second open, with branches unanswered")
	eq(item_ids(cx.asked[2]), item_ids(cx.asked[1]), "items of the second picker")
	eq(cx.asked[2].opts.placeholder, "Search branches in app", "placeholder")
	eq(table.concat(argv_lines(plugin, "branches"), ";"), "branches --repo /r/app", "background branches calls")
end)

test("the third open shows the answer of the background branches", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	plugin:answer("branches", UPDATED, 0, cx)
	eq(open(plugin, cx), 3, "pickers after the third open, with branches unanswered")
	eq(item_ids(cx.asked[3]), "new other b:main b:x b:y*", "items of the third picker")
end)

test("at most one background branches runs per repository", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	open(plugin, cx)
	eq(#cx.asked, 3, "pickers")
	eq(#argv_lines(plugin, "branches"), 1, "branches calls")
	plugin:answer("branches", UPDATED, 0, cx)
	open(plugin, cx)
	eq(#argv_lines(plugin, "branches"), 1, "branches calls after the refresh answered")
end)

test("a failed background branches keeps the cache and toasts the cause", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	plugin:answer("branches", FAILED, 1, cx)
	eq(toast_lines(cx), REFRESHING .. "; error Branch refresh failed: fetch failed", "toasts after the failed refresh")
	eq(open(plugin, cx), 3, "pickers after the third open")
	eq(item_ids(cx.asked[3]), item_ids(cx.asked[1]), "items of the third picker")
end)

test("a failed first branches still shows its error", function()
	local plugin, cx = window()
	open(plugin, cx)
	plugin:answer("branches", FAILED, 1, cx)
	eq(#cx.asked, 0, "pickers")
	eq(cx.toasts[#cx.toasts].title, "fetch failed", "toast title")
	eq(open(plugin, cx), 0, "pickers on the next open, which waits for branches again")
	eq(#argv_lines(plugin, "branches"), 1, "branches calls")
end)

test("a background branches with a failed pull request list keeps the cached pull requests", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	plugin:answer("branches", PR_LIST_FAILED, 0, cx)
	open(plugin, cx)
	eq(item_ids(cx.asked[#cx.asked]), "new other pr:7 b:main b:x b:y*", "items after the failed pull request list")
end)

test("a second press during the first branches starts no second one and opens one picker", function()
	local plugin, cx = window()
	open(plugin, cx)
	eq(open(plugin, cx), 0, "pickers after the second press")
	eq(#argv_lines(plugin, "branches"), 1, "branches calls after the second press")
	plugin:answer("branches", BRANCHES, 0, cx)
	eq(#cx.asked, 1, "pickers after branches answers")
	eq(#argv_lines(plugin, "branches"), 0, "branches calls after the answer")
end)

test("a teardown during the first branches runs one more branches after it", function()
	local plugin, cx = window()
	open(plugin, cx)
	local call = { reply = function(_self: any, _res: any) end, fail = function(_self: any, _err: string) end }
	function call.wait(_self: any, _ms: number): any
		return nil
	end
	plugin.exports.remove("/wt/worktrees/app/x", nil, cx, call)
	plugin:answer("remove", '{"removed":"/wt/worktrees/app/x","branch":"x","warnings":[]}', 0, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	eq(#cx.asked, 1, "pickers after the first branches answers")
	eq(table.concat(argv_lines(plugin, "branches"), ";"), "branches --repo /r/app --offline", "rerun")
	plugin:answer("branches", STALE, 0, cx)
	open(plugin, cx)
	eq(item_ids(cx.asked[#cx.asked]), "new other pr:7 b:main", "items after the teardown")
end)

test("a press after a first branches that never answered for 120 s starts it again", function()
	local plugin, cx = window()
	open(plugin, cx)
	local dropped = drop_branches(plugin)
	plugin:tick(120000)
	eq(open(plugin, cx), 0, "pickers after a press at 120 s")
	eq(#argv_lines(plugin, "branches"), 0, "branches calls after a press at 120 s")
	plugin:tick(1)
	eq(open(plugin, cx), 0, "pickers after a press after 120 s")
	eq(#argv_lines(plugin, "branches"), 1, "branches calls after a press after 120 s")
	plugin:answer("branches", BRANCHES, 0, cx)
	eq(#cx.asked, 1, "pickers after the new branches answers")
	dropped[1].cb({ stdout = STALE, stderr = "", status = 0 }, cx)
	eq(#cx.asked, 1, "pickers after the late answer of the dropped branches")
	open(plugin, cx)
	eq(item_ids(cx.asked[#cx.asked]), item_ids(cx.asked[1]), "items after the late answer")
end)

test("a press after a background branches that never answered for 120 s starts a new one", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	drop_branches(plugin)
	plugin:tick(120000)
	eq(open(plugin, cx), 3, "pickers after a press at 120 s")
	eq(#argv_lines(plugin, "branches"), 0, "branches calls after a press at 120 s")
	eq(toast_lines(cx), REFRESHING, "toasts after a press at 120 s")
	plugin:tick(1)
	eq(open(plugin, cx), 4, "pickers after a press after 120 s")
	eq(table.concat(argv_lines(plugin, "branches"), ";"), "branches --repo /r/app", "new background branches")
	eq(toast_lines(cx), REFRESHING .. "; " .. REFRESHING, "toasts after a press after 120 s")
	plugin:answer("branches", UPDATED, 0, cx)
	open(plugin, cx)
	eq(item_ids(cx.asked[#cx.asked]), "new other b:main b:x b:y*", "items after the new background branches")
end)

test("choosing a branch in a cached picker creates its worktree", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	cx.asked[2].next(item_by_id(cx.asked[2], "b:x"), nil, cx)
	eq(table.concat(argv_lines(plugin, "create"), ";"), "create --repo /r/app --no-tab --branch=x", "create argv")
end)

test("a create refreshes the cache offline and keeps its pull requests and default branch", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	cx.asked[1].next(item_by_id(cx.asked[1], "b:x"), nil, cx)
	plugin:answer("create", CREATED, 0, cx)
	local online, offline = branches_calls(plugin)
	eq(online, 0, "online branches calls after the create")
	eq(offline >= 1, true, "offline branches calls after the create")
	plugin:answer("branches", OFFLINE, 0, cx)
	open(plugin, cx)
	local picker = cx.asked[#cx.asked]
	eq(item_ids(picker), "new other pr:7 b:main b:x b:y*", "items after the create")
	eq(picker.opts.items[1].detail, "from main", "default branch after the create")
end)

test("a create during an online background branches runs one offline after it", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	cx.asked[2].next(item_by_id(cx.asked[2], "b:x"), nil, cx)
	plugin:answer("create", CREATED, 0, cx)
	plugin:answer("branches", STALE, 0, cx)
	eq(table.concat(argv_lines(plugin, "branches"), ";"), "branches --repo /r/app --offline", "rerun")
	plugin:answer("branches", OFFLINE, 0, cx)
	open(plugin, cx)
	eq(item_ids(cx.asked[#cx.asked]), "new other b:main b:x b:y*", "items after the create")
end)

test("an open during an offline refresh runs one online after it", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	cx.asked[1].next(item_by_id(cx.asked[1], "b:x"), nil, cx)
	plugin:answer("create", CREATED, 0, cx)
	eq(open(plugin, cx), 2, "pickers after the open")
	eq(toast_lines(cx), "", "toasts after the open during the offline refresh")
	plugin:answer("branches", OFFLINE, 0, cx)
	eq(table.concat(argv_lines(plugin, "branches"), ";"), "branches --repo /r/app", "rerun")
	eq(toast_lines(cx), REFRESHING, "toasts after the online rerun starts")
	plugin:answer("branches", UPDATED, 0, cx)
	eq(toast_lines(cx), REFRESHING .. "; " .. CHANGED, "toasts after the online rerun")
	open(plugin, cx)
	eq(item_ids(cx.asked[#cx.asked]), "new other b:main b:x b:y*", "items after the online rerun")
end)

test("a teardown refreshes the cache offline", function()
	local plugin, cx = window()
	first_open(plugin, cx, BRANCHES)
	local call = { reply = function(_self: any, _res: any) end, fail = function(_self: any, _err: string) end }
	function call.wait(_self: any, _ms: number): any
		return nil
	end
	plugin.exports.remove("/wt/worktrees/app/x", nil, cx, call)
	plugin:answer("remove", '{"removed":"/wt/worktrees/app/x","branch":"x","warnings":[]}', 0, cx)
	local online, offline = branches_calls(plugin)
	eq(online, 0, "online branches calls after the teardown")
	eq(offline >= 1, true, "offline branches calls after the teardown")
	plugin:answer("branches", STALE, 0, cx)
	open(plugin, cx)
	eq(item_ids(cx.asked[#cx.asked]), "new other pr:7 b:main", "items after the teardown")
end)

runner.finish()
