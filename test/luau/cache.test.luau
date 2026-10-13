--!strict

local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local REPO = "/r/app"
local ENV = { HOME = "/home/u" }
local RESOLVED = Stub.fixture("resolve", { repo = REPO })
-- The `branches` answer of the CLI for REPO with a worktree of x and the pull request 7.
local BRANCHES = Stub.fixture("branches", Stub.worktree_vars("x"))
-- The worktree of y in the `worktrees` of a `branches` answer.
local Y_WORKTREE = { branch = "y", path = "/wt/worktrees/app/y", managed = true, owner = "tern", main = false }
local UPDATED = Stub.answer(
	"branches-offline",
	{ repo = REPO },
	{ branches = { "main", "x", "y" }, worktrees = { Y_WORKTREE } }
)
local STALE = Stub.answer("branches-offline", { repo = REPO }, { branches = { "main" }, worktrees = {} })
local OFFLINE = Stub.answer(
	"branches-offline",
	{ repo = REPO },
	{ default = "dev", branches = { "main", "x", "y" }, worktrees = { Y_WORKTREE } }
)
local FAILED = '{"error":{"code":"git_failed","message":"fetch failed"}}'
-- The `branches` answer of the CLI when `gh pr list` fails, for REPO with a worktree of x.
local PR_LIST_FAILED_VARS = Stub.worktree_vars("x")
local PR_LIST_FAILED = Stub.fixture("branches-pr-list-failed", PR_LIST_FAILED_VARS)
local LOADING = "info Loading branches…"
local LOADED = "info Branches loaded"
local REFRESHING = "info Refreshing branches…"
local CHANGED = "info Branches refreshed: reopen to see changes"
local UNCHANGED = "info Branches refreshed: no changes"
local CREATED = Stub.fixture("create-created", Stub.worktree_vars("y"))
local REMOVED = Stub.answer("remove-kept-policy", Stub.worktree_vars("x"), { branch = "x" })

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

-- A window with pane 1 in REPO and `git.auto_fetch_minutes` set to `minutes`.
local function window(minutes: number): (Stub.Harness, any)
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = REPO } }, 1, { fail = { new_tab = true } })
	cx.settings = {
		get = function(_self: any, _key: string): any
			return minutes
		end,
	}
	return Stub.load({ env = ENV }), cx
end

-- The `branches` calls that are pending, online and offline.
local function branches_calls(plugin: Stub.Harness): (number, number)
	local online, offline = 0, 0
	for _, line in plugin:pending("branches") do
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
-- and loaded toasts, then clears the toasts.
local function first_open(plugin: Stub.Harness, cx: any, stdout: string)
	eq(open(plugin, cx), 0, "pickers before branches answers on the first open")
	eq(#plugin:pending("branches"), 1, "branches calls on the first open")
	plugin:answer("branches", stdout, 0, cx)
	eq(#cx.asked, 1, "pickers after the first open")
	eq(toast_lines(cx), LOADING .. "; " .. LOADED, "toasts after the first open")
	table.clear(cx.toasts)
end

test("the first open shows a loading toast while branches runs, then a loaded toast", function()
	local plugin, cx = window(0)
	open(plugin, cx)
	eq(toast_lines(cx), LOADING, "toasts while the first branches runs")
	open(plugin, cx)
	eq(toast_lines(cx), LOADING, "toasts after a second press during the first branches")
	plugin:answer("branches", BRANCHES, 0, cx)
	eq(#cx.asked, 1, "pickers after branches answers")
	eq(toast_lines(cx), LOADING .. "; " .. LOADED, "toasts after branches answers")
end)

test("a cached open shows a refreshing toast", function()
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	eq(open(plugin, cx), 2, "pickers after the second open")
	eq(toast_lines(cx), REFRESHING, "toasts after the second open")
end)

test("a background branches that changes the picker toasts to reopen it", function()
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	plugin:answer("branches", UPDATED, 0, cx)
	eq(toast_lines(cx), REFRESHING .. "; " .. CHANGED, "toasts after the refresh")
end)

test("a background branches with the same picker toasts no changes", function()
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	eq(toast_lines(cx), REFRESHING .. "; " .. UNCHANGED, "toasts after the refresh")
end)

test("a background branches compares after it keeps the cached pull requests", function()
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	plugin:answer("branches", PR_LIST_FAILED, 0, cx)
	eq(toast_lines(cx), REFRESHING .. "; " .. UNCHANGED, "toasts after the refresh")
end)

test("a second press during a background branches shows one loading and one finish toast", function()
	local plugin, cx = window(0)
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
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	cx.asked[1].next(Stub.item(cx.asked[1], "b:x"), nil, cx)
	plugin:answer("create", CREATED, 0, cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	plugin:answer("branches", OFFLINE, 0, cx)
	local call = Stub.call()
	plugin.exports.remove("/wt/worktrees/app/x", nil, cx, call)
	plugin:answer("remove", REMOVED, 0, cx)
	plugin:answer("branches", STALE, 0, cx)
	eq(toast_lines(cx), "", "toasts after the create and the teardown")
end)

test("a second open shows the cached picker before branches answers", function()
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	eq(open(plugin, cx), 2, "pickers after the second open, with branches unanswered")
	eq(item_ids(cx.asked[2]), item_ids(cx.asked[1]), "items of the second picker")
	eq(cx.asked[2].opts.placeholder, "Search branches in app", "placeholder")
	eq(plugin:pending_line("branches"), "branches --repo /r/app", "background branches calls")
end)

test("the third open shows the answer of the background branches", function()
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	plugin:answer("branches", UPDATED, 0, cx)
	eq(open(plugin, cx), 3, "pickers after the third open, with branches unanswered")
	eq(item_ids(cx.asked[3]), "new other b:main b:x b:y*", "items of the third picker")
end)

test("at most one background branches runs per repository", function()
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	open(plugin, cx)
	eq(#cx.asked, 3, "pickers")
	eq(#plugin:pending("branches"), 1, "branches calls")
	plugin:answer("branches", UPDATED, 0, cx)
	open(plugin, cx)
	eq(#plugin:pending("branches"), 1, "branches calls after the refresh answered")
end)

test("a failed background branches keeps the cache and toasts the cause", function()
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	plugin:answer("branches", FAILED, 1, cx)
	eq(toast_lines(cx), REFRESHING .. "; error Branch refresh failed: fetch failed", "toasts after the failed refresh")
	eq(open(plugin, cx), 3, "pickers after the third open")
	eq(item_ids(cx.asked[3]), item_ids(cx.asked[1]), "items of the third picker")
end)

test("a failed first branches still shows its error", function()
	local plugin, cx = window(0)
	open(plugin, cx)
	plugin:answer("branches", FAILED, 1, cx)
	eq(#cx.asked, 0, "pickers")
	eq(cx.toasts[#cx.toasts].title, "fetch failed", "toast title")
	eq(open(plugin, cx), 0, "pickers on the next open, which waits for branches again")
	eq(#plugin:pending("branches"), 1, "branches calls")
end)

test("a background branches with a failed pull request list keeps the cached pull requests", function()
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	plugin:answer("branches", PR_LIST_FAILED, 0, cx)
	open(plugin, cx)
	Stub.item(cx.asked[#cx.asked], "pr:7")
end)

test(
	"a background branches with prsFailed false replaces the cached pull requests, whatever its warnings say",
	function()
		local plugin, cx = window(0)
		first_open(plugin, cx, BRANCHES)
		open(plugin, cx)
		plugin:answer(
			"branches",
			Stub.answer("branches-pr-list-failed", PR_LIST_FAILED_VARS, { prsFailed = false }),
			0,
			cx
		)
		open(plugin, cx)
		local found, err = pcall(Stub.item, cx.asked[#cx.asked], "pr:7")
		eq(found, false, "pr:7 after an answer with no pull requests")
		eq(err, "no item pr:7", "lookup error")
	end
)

-- A window with pane 1 in REPO and `git.auto_fetch_minutes` 5, whose worktree rows run an online `branches` and get
-- BRANCHES. Five minutes on, a focus on pane 1 runs the next online `branches`, which gets `stdout`.
local function rows_after(stdout: string): (Stub.Harness, any)
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = REPO } }, 1)
	cx.settings = {
		get = function(_self: any, _key: string): any
			return 5
		end,
	}
	local plugin = Stub.load({ env = ENV })
	plugin.handlers.window_start(cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	eq(plugin:pending_line("branches"), "branches --repo /r/app", "first rows branches")
	plugin:answer("branches", BRANCHES, 0, cx)
	plugin:tick(5 * 60000)
	plugin.handlers.focus({ pane = 1 }, cx)
	eq(plugin:pending_line("branches"), "branches --repo /r/app", "next rows branches")
	plugin:answer("branches", stdout, 0, cx)
	return plugin, cx
end

-- Whether the worktree row of pull request 7 shows in the command palette for pane 1.
local function pr_row_shows(plugin: Stub.Harness, cx: any): boolean
	for _, spec in plugin.commands do
		if spec.title == "app: #7 Fix login" then
			return spec.available(cx)
		end
	end
	return false
end

test("the worktree rows keep their pull requests after an answer with prsFailed true", function()
	local plugin, cx = rows_after(PR_LIST_FAILED)
	eq(pr_row_shows(plugin, cx), true, "pull request row")
end)

test(
	"the worktree rows drop their pull requests after an answer with prsFailed false, whatever its warnings say",
	function()
		local plugin, cx =
			rows_after(Stub.answer("branches-pr-list-failed", PR_LIST_FAILED_VARS, { prsFailed = false }))
		eq(pr_row_shows(plugin, cx), false, "pull request row")
	end
)

test("a second press during the first branches starts no second one and opens one picker", function()
	local plugin, cx = window(0)
	open(plugin, cx)
	eq(open(plugin, cx), 0, "pickers after the second press")
	eq(#plugin:pending("branches"), 1, "branches calls after the second press")
	plugin:answer("branches", BRANCHES, 0, cx)
	eq(#cx.asked, 1, "pickers after branches answers")
	eq(#plugin:pending("branches"), 0, "branches calls after the answer")
end)

test("a teardown during the first branches runs one more branches after it", function()
	local plugin, cx = window(0)
	open(plugin, cx)
	local call = Stub.call()
	plugin.exports.remove("/wt/worktrees/app/x", nil, cx, call)
	plugin:answer("remove", REMOVED, 0, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	eq(#cx.asked, 1, "pickers after the first branches answers")
	eq(plugin:pending_line("branches"), "branches --repo /r/app --offline", "rerun")
	plugin:answer("branches", STALE, 0, cx)
	open(plugin, cx)
	eq(item_ids(cx.asked[#cx.asked]), "new other pr:7 b:main", "items after the teardown")
end)

test("a press after a first branches that never answered for 120 s starts it again", function()
	local plugin, cx = window(0)
	open(plugin, cx)
	local dropped = drop_branches(plugin)
	plugin:tick(120000)
	eq(open(plugin, cx), 0, "pickers after a press at 120 s")
	eq(#plugin:pending("branches"), 0, "branches calls after a press at 120 s")
	plugin:tick(1)
	eq(open(plugin, cx), 0, "pickers after a press after 120 s")
	eq(#plugin:pending("branches"), 1, "branches calls after a press after 120 s")
	plugin:answer("branches", BRANCHES, 0, cx)
	eq(#cx.asked, 1, "pickers after the new branches answers")
	dropped[1].cb({ stdout = STALE, stderr = "", status = 0 }, cx)
	eq(#cx.asked, 1, "pickers after the late answer of the dropped branches")
	open(plugin, cx)
	eq(item_ids(cx.asked[#cx.asked]), item_ids(cx.asked[1]), "items after the late answer")
end)

test("a press after a background branches that never answered for 120 s starts a new one", function()
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	drop_branches(plugin)
	plugin:tick(120000)
	eq(open(plugin, cx), 3, "pickers after a press at 120 s")
	eq(#plugin:pending("branches"), 0, "branches calls after a press at 120 s")
	eq(toast_lines(cx), REFRESHING, "toasts after a press at 120 s")
	plugin:tick(1)
	eq(open(plugin, cx), 4, "pickers after a press after 120 s")
	eq(plugin:pending_line("branches"), "branches --repo /r/app", "new background branches")
	eq(toast_lines(cx), REFRESHING .. "; " .. REFRESHING, "toasts after a press after 120 s")
	plugin:answer("branches", UPDATED, 0, cx)
	open(plugin, cx)
	eq(item_ids(cx.asked[#cx.asked]), "new other b:main b:x b:y*", "items after the new background branches")
end)

test("choosing a branch in a cached picker creates its worktree", function()
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	cx.asked[2].next(Stub.item(cx.asked[2], "b:x"), nil, cx)
	eq(plugin:pending_line("create"), "create --repo /r/app --no-tab --branch=x", "create argv")
end)

test("a create refreshes the cache offline and keeps its pull requests and default branch", function()
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	cx.asked[1].next(Stub.item(cx.asked[1], "b:x"), nil, cx)
	plugin:answer("create", CREATED, 0, cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	local online, offline = branches_calls(plugin)
	eq(online, 0, "online branches calls after the create")
	eq(offline, 1, "offline branches calls after the create")
	plugin:answer("branches", OFFLINE, 0, cx)
	open(plugin, cx)
	local picker = cx.asked[#cx.asked]
	eq(item_ids(picker), "new other pr:7 b:main b:x b:y*", "items after the create")
	eq(picker.opts.items[1].detail, "from main", "default branch after the create")
end)

test("a create during an online background branches runs one offline after it", function()
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	open(plugin, cx)
	cx.asked[2].next(Stub.item(cx.asked[2], "b:x"), nil, cx)
	plugin:answer("create", CREATED, 0, cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	plugin:answer("branches", STALE, 0, cx)
	eq(plugin:pending_line("branches"), "branches --repo /r/app --offline", "rerun")
	plugin:answer("branches", OFFLINE, 0, cx)
	open(plugin, cx)
	eq(item_ids(cx.asked[#cx.asked]), "new other b:main b:x b:y*", "items after the create")
end)

test("an open during an offline refresh runs one online after it", function()
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	cx.asked[1].next(Stub.item(cx.asked[1], "b:x"), nil, cx)
	plugin:answer("create", CREATED, 0, cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	eq(open(plugin, cx), 2, "pickers after the open")
	eq(toast_lines(cx), "", "toasts after the open during the offline refresh")
	plugin:answer("branches", OFFLINE, 0, cx)
	eq(plugin:pending_line("branches"), "branches --repo /r/app", "rerun")
	eq(toast_lines(cx), REFRESHING, "toasts after the online rerun starts")
	plugin:answer("branches", UPDATED, 0, cx)
	eq(toast_lines(cx), REFRESHING .. "; " .. CHANGED, "toasts after the online rerun")
	open(plugin, cx)
	eq(item_ids(cx.asked[#cx.asked]), "new other b:main b:x b:y*", "items after the online rerun")
end)

test("a teardown refreshes the cache offline", function()
	local plugin, cx = window(0)
	first_open(plugin, cx, BRANCHES)
	local call = Stub.call()
	plugin.exports.remove("/wt/worktrees/app/x", nil, cx, call)
	plugin:answer("remove", REMOVED, 0, cx)
	local online, offline = branches_calls(plugin)
	eq(online, 0, "online branches calls after the teardown")
	eq(offline, 1, "offline branches calls after the teardown")
	plugin:answer("branches", STALE, 0, cx)
	open(plugin, cx)
	eq(item_ids(cx.asked[#cx.asked]), "new other pr:7 b:main", "items after the teardown")
end)

runner.finish()
