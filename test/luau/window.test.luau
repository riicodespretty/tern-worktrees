--!strict

local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local ENV = { HOME = "/home/u" }
local ROOT = "/wt/worktrees"
local WORKTREE = "/wt/worktrees/app/feat"
local CONFIG = '{"teardown":"worktree+merged-branch","cloneRoot":"/home/u/Developer","hotkeys":{"new":["cmd+shift+w"]},'
	.. '"setup":{}}'

type OwnerCase = {
	what: string,
	entry: { [string]: any },
	panes: { Stub.Pane },
	exists: boolean,
	asks: boolean,
}

local function entry_with(owner: string?): { [string]: any }
	return { main = "/r/app", branch = "feat", changed = 0, owner = owner }
end

for _, case in
	{
		{
			what = "owner tern",
			entry = entry_with("tern"),
			panes = { { pane = 1, tab = 1, cwd = WORKTREE } },
			exists = true,
			asks = true,
		},
		{
			what = "owner tern and a cwd nested in the worktree",
			entry = entry_with("tern"),
			panes = { { pane = 1, tab = 1, cwd = WORKTREE .. "/src" } },
			exists = true,
			asks = true,
		},
		{
			what = "owner omp",
			entry = entry_with("omp"),
			panes = { { pane = 1, tab = 1, cwd = WORKTREE } },
			exists = true,
			asks = false,
		},
		{
			what = "no owner",
			entry = entry_with(nil),
			panes = { { pane = 1, tab = 1, cwd = WORKTREE } },
			exists = true,
			asks = false,
		},
		{
			what = "an unknown owner",
			entry = entry_with("orca"),
			panes = { { pane = 1, tab = 1, cwd = WORKTREE } },
			exists = true,
			asks = false,
		},
		{
			what = "owner tern and a deleted folder",
			entry = entry_with("tern"),
			panes = { { pane = 1, tab = 1, cwd = WORKTREE } },
			exists = false,
			asks = false,
		},
		{
			what = "owner tern and a pane of another tab in the worktree",
			entry = entry_with("tern"),
			panes = { { pane = 1, tab = 1, cwd = WORKTREE .. "/src" }, { pane = 2, tab = 2, cwd = WORKTREE } },
			exists = true,
			asks = false,
		},
	} :: { OwnerCase }
do
	test(`close_tab {if case.asks then "asks" else "does not ask"} for a worktree with {case.what}`, function()
		local cx = Stub.cx(case.panes, 1)
		local plugin = Stub.load({
			env = ENV,
			files = if case.exists then { [WORKTREE .. "/.git"] = "" } else {},
			kv = { worktreeRoot = ROOT, worktreeIndex = { [WORKTREE] = case.entry } },
		})
		eq(plugin.overrides.close_tab(cx), case.asks, "close_tab result")
		plugin:answer("config", CONFIG, 0, cx)
		eq(#cx.asked, if case.asks then 1 else 0, "pickers and prompts opened")
	end)
end

test("window_start reads the worktree root from the list output", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app/feat" } }, 1)
	local plugin = Stub.load({ env = ENV, files = { ["/r/app/feat/.git"] = "" } })
	plugin.handlers.window_start(cx)
	plugin:answer(
		"list",
		'{"root":"/r/","worktrees":[{"path":"/r/app/feat","repo":"/src/app","branch":"feat","dirty":false,'
			.. '"changed":0,"owner":"tern"}]}'
	)
	eq(plugin.kv.worktreeRoot, "/r", "remembered worktree root")
	eq(plugin.overrides.close_tab(cx), true, "close_tab result")
	plugin:answer("config", CONFIG, 0, cx)
	eq(#cx.asked, 1, "pickers and prompts opened")
end)

test("without a kept worktree root the window half has no ~/.tern-wt/worktrees root", function()
	local OLD = "/home/u/.tern-wt/worktrees/app/x"
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = OLD } }, 1)
	local plugin = Stub.load({ env = ENV, files = { [OLD .. "/.git"] = "gitdir: /src/app/.git/worktrees/x\n" } })
	eq(plugin:status(OLD), nil, "segments in the old default root")
	plugin.handlers.cwd({ pane = 1, path = OLD }, cx)
	local lists = 0
	for _, run in plugin.runs do
		if run.argv[2] == "list" then
			lists += 1
		end
	end
	eq(lists, 0, "list runs for a cwd in the old default root")
	eq(plugin.overrides.close_tab(cx), false, "close_tab result")
	eq(#cx.asked, 0, "pickers and prompts opened")
end)

local FEAT = "/wt/worktrees/app/feat"
local OMP = "/wt/7-abc1234"
local LISTED = '{"root":"/wt/worktrees","worktrees":['
	.. '{"path":"/wt/worktrees/app/feat","repo":"/r/app","branch":"feat","dirty":true,"changed":3,"owner":"tern"},'
	.. '{"path":"/wt/7-abc1234","repo":"/r/app","branch":null,"dirty":false,"changed":0,"owner":"omp"}]}'
local RESOLVED = '{"repos":[{"dir":"/r/app","root":"/r/app","name":"app"}]}'
local BRANCHES =
	[[{"name":"app","default":"main","branches":["main","x"],"prs":[],"prsFailed":false,"worktrees":[],"warnings":[]}]]
local REMOVED = '{"removed":"/wt/worktrees/app/feat","repo":"/r/app","branch":"feat","branchDeleted":false,'
	.. '"branchKept":"policy","warnings":[]}'
local CREATED = '{"branch":"x","carried":[],"owner":"tern","path":"/wt/worktrees/app/x","repo":"/r/app",'
	.. '"status":"created","warnings":[]}'

local function argv_lines(plugin: Stub.Harness, verb: string): { string }
	local found: { string } = {}
	for _, run in plugin.runs do
		if run.argv[2] == verb then
			table.insert(found, table.concat(run.argv, " ", 2))
		end
	end
	return found
end

-- Starts a window with one pane in `cwd`, and answers its `list --all` with LISTED.
local function started(cwd: string): (Stub.Harness, any)
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = cwd } }, 1)
	local plugin = Stub.load({ env = ENV })
	plugin.handlers.window_start(cx)
	plugin:answer("list", LISTED, 0, cx)
	return plugin, cx
end

-- Picks the branch `x` of /r/app in the branch picker. Then `create` is the pending CLI call.
local function pick_branch_x(plugin: Stub.Harness, cx: any)
	plugin.commands.new.run(cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	local picker = cx.asked[#cx.asked]
	for _, it in picker.opts.items do
		if it.id == "b:x" then
			picker.next(it, nil, cx)
		end
	end
	eq(#argv_lines(plugin, "create"), 1, "create calls")
end

test("window_start writes the worktree index from list --all", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/home/u" } }, 1)
	local plugin = Stub.load({ env = ENV })
	plugin.handlers.window_start(cx)
	eq(table.concat(argv_lines(plugin, "list"), ";"), "list --all", "list calls")
	plugin:answer("list", LISTED, 0, cx)
	local feat = plugin.kv.worktreeIndex[FEAT]
	eq(feat.main, "/r/app", "main of feat")
	eq(feat.branch, "feat", "branch of feat")
	eq(feat.changed, 3, "changed of feat")
	eq(feat.owner, "tern", "owner of feat")
	local omp = plugin.kv.worktreeIndex[OMP]
	eq(omp.main, "/r/app", "main of the omp-owned worktree")
	eq(omp.branch, nil, "branch of the detached omp-owned worktree")
	eq(omp.changed, 0, "changed of the omp-owned worktree")
	eq(omp.owner, "omp", "owner of the omp-owned worktree")
end)

-- A `tern-wt setup` answer with the action `bin` for the CLI link and `skill` for the skill link.
local function setup_answer(bin: string, skill: string): string
	return `\{"links":[\{"path":"/home/u/.local/bin/tern-wt","target":"/p/bin/tern-wt","action":"{bin}"},`
		.. `\{"path":"/home/u/.omp/agent/skills/tern-worktrees","target":"/p/skills/tern-worktrees","action":"{skill}"}]}`
end

-- Loads the window half, checks that the load itself starts no `setup`, that its timer then runs `setup` one time, and
-- that a window start runs no second one, and answers it with `stdout` and `status`. Gives the toasts that the answer
-- added, as `level title` lines.
local function toasts_after_setup(stdout: string, status: number): string
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/home/u" } }, 1)
	local plugin = Stub.load({ env = ENV })
	eq(#argv_lines(plugin, "setup"), 0, "setup calls during the load")
	plugin:tick(0)
	eq(table.concat(argv_lines(plugin, "setup"), ";"), "setup", "setup calls after the timer")
	plugin.handlers.window_start(cx)
	eq(table.concat(argv_lines(plugin, "setup"), ";"), "setup", "setup calls after window_start")
	local before = #cx.toasts
	plugin:answer("setup", stdout, status, cx)
	local lines: { string } = {}
	for i = before + 1, #cx.toasts do
		table.insert(lines, cx.toasts[i].level .. " " .. cx.toasts[i].title)
	end
	return table.concat(lines, "; ")
end

local LINKED = "info Linked tern-wt and the tern-worktrees skill"

for _, case in
	{
		{ what = "both links created", bin = "created", skill = "created", toasts = LINKED },
		{ what = "one link replaced", bin = "kept", skill = "replaced", toasts = LINKED },
		{ what = "one link created", bin = "created", skill = "kept", toasts = LINKED },
		{ what = "both links kept", bin = "kept", skill = "kept", toasts = "" },
	}
do
	test(`loading the window half runs setup, and an answer with {case.what} toasts "{case.toasts}"`, function()
		eq(toasts_after_setup(setup_answer(case.bin, case.skill), 0), case.toasts, "toasts")
	end)
end

test("a failed setup at load toasts Setup failed with its message", function()
	local failed =
		'{"error":{"code":"path_conflict","message":"/home/u/.local/bin/tern-wt exists and is not a symbolic link"}}'
	eq(
		toasts_after_setup(failed, 1),
		"error Setup failed: /home/u/.local/bin/tern-wt exists and is not a symbolic link",
		"toasts"
	)
end)

-- Counts the teardown pickers that a close of tab 2 opens, after the plugin made tab 2 from a `create` answer with
-- `owner`.
local function pickers_after_close_of_created_tab(owner: string): number
	local X = "/wt/worktrees/app/x"
	local panes: { Stub.Pane } = { { pane = 1, tab = 1, cwd = "/r/app" } }
	local cx = Stub.cx(panes, 1)
	local plugin = Stub.load({ env = ENV, files = { [X .. "/.git"] = "" }, kv = { worktreeRoot = ROOT } })
	pick_branch_x(plugin, cx)
	plugin:answer(
		"create",
		`\{"branch":"x","carried":[],"owner":"{owner}","path":"{X}","repo":"/r/app","status":"created","warnings":[]}`,
		0,
		cx
	)
	plugin:answer("resolve", RESOLVED, 0, cx)
	local after = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local before = #after.asked
	plugin.handlers.tab_closed({ tab = 2 }, after)
	plugin:answer("config", CONFIG, 0, after)
	return #after.asked - before
end

test("a create answer with owner tern makes a worktree tab, and owner omp does not", function()
	eq(pickers_after_close_of_created_tab("tern"), 1, "pickers after a close of the tab of owner tern")
	eq(pickers_after_close_of_created_tab("omp"), 0, "pickers after a close of the tab of owner omp")
end)

-- Picks `main` in the branch picker of a window with pane 1 in `cwd`, a dir of /r/app, then answers the `create` with
-- the main checkout of /r/app and the `resolve` after it. /r/app exists on disk, so a close of its tab would ask when
-- the window took it for a worktree.
local function create_main_checkout(cwd: string): (Stub.Harness, any)
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = cwd } }, 1)
	local plugin = Stub.load({ env = ENV, files = { ["/r/app/.git"] = "" }, kv = { worktreeRoot = ROOT } })
	local resolved = `\{"repos":[\{"dir":"{cwd}","root":"/r/app","name":"app"}]}`
	plugin.commands.new.run(cx)
	plugin:answer("resolve", resolved, 0, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	local picker = cx.asked[#cx.asked]
	for _, it in picker.opts.items do
		if it.id == "b:main" then
			picker.next(it, nil, cx)
		end
	end
	eq(#argv_lines(plugin, "create"), 1, "create calls")
	plugin:answer("create", Stub.fixture("create-main-checkout", { repo = "/r/app" }), 0, cx)
	plugin:answer("resolve", resolved, 0, cx)
	return plugin, cx
end

-- The last toast of `cx` as `level title · detail`.
local function last_toast(cx: any): string
	local t = cx.toasts[#cx.toasts]
	return `{t.level} {t.title} · {t.detail}`
end

-- Closes `tab`, with one pane left in /tmp, and checks that the close runs no `config` and opens no picker. A close
-- that asks runs `config` first.
local function expect_no_close_picker(plugin: Stub.Harness, tab: number)
	local after = Stub.cx({ { pane = 3, tab = 3, cwd = "/tmp" } }, 3)
	local configs = #argv_lines(plugin, "config")
	plugin.handlers.tab_closed({ tab = tab }, after)
	eq(#argv_lines(plugin, "config"), configs, "config calls after the close")
	eq(#after.asked, 0, "pickers after the close")
end

test("a create answer with owner main focuses the tab of the main checkout and writes no index entry", function()
	local plugin, cx = create_main_checkout("/r/app")
	eq(table.concat(cx.effects, "; "), "focus 1", "effects")
	eq((plugin.kv.worktreeIndex or {})["/r/app"], nil, "index entry of the main checkout")
	eq(last_toast(cx), "success Opened main checkout · /r/app", "toast")
	eq(plugin.overrides.close_tab(cx), false, "close_tab result")
	expect_no_close_picker(plugin, 1)
end)

test("a create answer with owner main opens a tab for the main checkout when no tab shows it", function()
	local plugin, cx = create_main_checkout(WORKTREE)
	eq(table.concat(cx.effects, "; "), "new_tab → tab 2, pane 2; name_tab 2 main", "effects")
	eq((plugin.kv.worktreeIndex or {})["/r/app"], nil, "index entry of the main checkout")
	eq(last_toast(cx), "success Opened main checkout · /r/app", "toast")
	expect_no_close_picker(plugin, 2)
end)

test("the Carly create export replies with the main checkout answer and writes no index entry", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = Stub.load({ env = ENV, kv = { worktreeRoot = ROOT } })
	local replied: any = nil
	local call = {
		reply = function(_self: any, res: any)
			replied = res
		end,
		fail = function(_self: any, err: string)
			error(err)
		end,
	}
	function call.wait(_self: any, _ms: number): any
		return nil
	end
	plugin.exports.create("/r/app", "main", nil, cx, call)
	plugin:answer("create", Stub.fixture("create-main-checkout", { repo = "/r/app" }), 0, cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	eq(replied ~= nil and `{replied.owner} {replied.path} {replied.status}`, "main /r/app reused", "reply")
	eq((plugin.kv.worktreeIndex or {})["/r/app"], nil, "index entry of the main checkout")
	eq(table.concat(cx.effects, "; "), "focus 1", "effects")
end)

-- A `branches` answer where the main checkout holds feat, the head branch of pull request 7, and a worktree holds x.
local CHECKOUTS = [[{"name":"app","default":"main","branches":["main","feat","x"],]]
	.. [["prs":[{"number":7,"title":"T","branch":"feat"}],"prsFailed":false,"worktrees":[]]
	.. [[{"branch":"feat","path":"/r/app","managed":false,"owner":null,"main":true},]]
	.. [[{"branch":"x","path":"/wt/worktrees/app/x","managed":true,"owner":"tern","main":false}],"warnings":[]}]]

-- The `level title` of the last toast after `start` runs the pending `create` of a window with pane 1 in /r/app.
local function progress_toast(start: (plugin: Stub.Harness, cx: any) -> ()): string
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = Stub.load({ env = ENV, kv = { worktreeRoot = ROOT } })
	start(plugin, cx)
	eq(#argv_lines(plugin, "create"), 1, "create calls")
	local t = cx.toasts[#cx.toasts]
	return `{t.level} {t.title}`
end

-- Picks the item `id` in the branch picker of /r/app with CHECKOUTS.
local function pick(id: string): (plugin: Stub.Harness, cx: any) -> ()
	return function(plugin, cx)
		plugin.commands.new.run(cx)
		plugin:answer("resolve", RESOLVED, 0, cx)
		plugin:answer("branches", CHECKOUTS, 0, cx)
		local picker = cx.asked[#cx.asked]
		for _, it in picker.opts.items do
			if it.id == id then
				picker.next(it, nil, cx)
			end
		end
	end
end

-- Runs the worktree row `title` of /r/app with CHECKOUTS.
local function run_row(title: string): (plugin: Stub.Harness, cx: any) -> ()
	return function(plugin, cx)
		plugin.handlers.cwd({ pane = 1, path = "/r/app" }, cx)
		plugin:answer("resolve", RESOLVED, 0, cx)
		plugin:answer("branches", CHECKOUTS, 0, cx)
		for _, spec in plugin.commands do
			if spec.group == "Worktrees" and spec.title == title then
				spec.run(cx)
			end
		end
	end
end

for _, case in
	{
		{
			what = "the branch of the main checkout in the branch picker",
			start = pick("b:feat"),
			toast = "info Opening main checkout…",
		},
		{
			what = "a pull request of that branch in the branch picker",
			start = pick("pr:7"),
			toast = "info Opening main checkout…",
		},
		{
			what = "the worktree row of that branch",
			start = run_row("app: feat"),
			toast = "info Opening main checkout…",
		},
		{
			what = "the worktree row of that pull request",
			start = run_row("app: #7 T"),
			toast = "info Opening main checkout…",
		},
		{ what = "a branch with a worktree", start = pick("b:x"), toast = "info Reusing worktree x…" },
		{ what = "a branch with no checkout", start = pick("b:main"), toast = "info Creating worktree main…" },
	}
do
	test(`a create of {case.what} toasts "{case.toast}" before the answer`, function()
		eq(progress_toast(case.start), case.toast, "progress toast")
	end)
end

test("a tab that the plugin did not open becomes a worktree tab after one list --all", function()
	local X = "/wt/worktrees/app/x"
	local panes: { Stub.Pane } = { { pane = 1, tab = 1, cwd = "/r/app" } }
	local cx = Stub.cx(panes, 1)
	local plugin = Stub.load({ env = ENV, files = { [X .. "/.git"] = "" }, kv = { worktreeRoot = ROOT } })
	plugin.handlers.window_start(cx)
	plugin:answer("list", LISTED, 0, cx)
	plugin:tick(2000)
	table.insert(panes, { pane = 2, tab = 2, cwd = X })
	plugin.handlers.tab_created({ tab = 2 }, cx)
	eq(#argv_lines(plugin, "list"), 1, "list runs after the tab opened")
	plugin:answer(
		"list",
		'{"root":"/wt/worktrees","worktrees":[{"path":"/wt/worktrees/app/x","repo":"/r/app","branch":"x",'
			.. '"dirty":false,"changed":0,"owner":"tern"}]}',
		0,
		cx
	)
	local after = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	plugin.handlers.tab_closed({ tab = 2 }, after)
	plugin:answer("config", CONFIG, 0, after)
	eq(#after.asked, 1, "pickers after a close of the tab")
end)

test("a pane in the repository folder of the worktree root starts no repeating list --all", function()
	local panes: { Stub.Pane } = { { pane = 1, tab = 1, cwd = "/r/app" } }
	local cx = Stub.cx(panes, 1)
	local plugin = Stub.load({ env = ENV, kv = { worktreeRoot = ROOT } })
	plugin.handlers.window_start(cx)
	plugin:answer("list", LISTED, 0, cx)
	plugin:tick(2000)
	table.insert(panes, { pane = 2, tab = 2, cwd = ROOT .. "/app" })
	plugin.handlers.tab_created({ tab = 2 }, cx)
	plugin:answer("list", LISTED, 0, cx)
	plugin:tick(2000)
	plugin:tick(2000)
	eq(#argv_lines(plugin, "list"), 0, "list runs after two ticks of 2 s")
end)

for _, event in { "tab_created", "pane_created" } do
	for _, case in
		{
			{ what = "only in indexed worktrees", cwds = { FEAT, FEAT .. "/src" } },
			{ what = "only outside the worktree root", cwds = { "/home/u", "/tmp/x" } },
		}
	do
		test(`{event} with new panes {case.what} starts no list --all`, function()
			local panes: { Stub.Pane } = { { pane = 1, tab = 1, cwd = "/r/app" } }
			local cx = Stub.cx(panes, 1)
			local plugin = Stub.load({ env = ENV, kv = { worktreeRoot = ROOT } })
			plugin.handlers.window_start(cx)
			plugin:answer("list", LISTED, 0, cx)
			plugin:tick(2000)
			for i, cwd in case.cwds do
				table.insert(panes, { pane = i + 1, tab = 2, cwd = cwd })
			end
			plugin.handlers[event]({ tab = 2 }, cx)
			plugin:tick(2000)
			eq(#argv_lines(plugin, "list"), 0, "list runs")
		end)
	end
end

test("command_finished events within 2 s start one list --all and one trailing run", function()
	local plugin, cx = started(FEAT .. "/src")
	plugin:tick(2000)
	plugin.handlers.command_finished({ pane = 1 }, cx)
	plugin.handlers.command_finished({ pane = 1 }, cx)
	eq(#argv_lines(plugin, "list"), 1, "list runs after two events")
	plugin:answer("list", LISTED, 0, cx)
	eq(#argv_lines(plugin, "list"), 0, "list runs right after the answer")
	plugin.handlers.command_finished({ pane = 1 }, cx)
	plugin.handlers.focus({ pane = 1 }, cx)
	plugin:tick(1999)
	eq(#argv_lines(plugin, "list"), 0, "list runs before 2 s")
	plugin:tick(1)
	eq(table.concat(argv_lines(plugin, "list"), ";"), "list --all", "trailing run")
	plugin:answer("list", LISTED, 0, cx)
	plugin:tick(2000)
	eq(#argv_lines(plugin, "list"), 0, "list runs after the trailing run")
end)

test("a refresh while list --all runs past 2 s waits for its answer", function()
	local plugin, cx = started(FEAT .. "/src")
	plugin:tick(2000)
	plugin.handlers.command_finished({ pane = 1 }, cx)
	plugin:tick(2500)
	plugin.handlers.command_finished({ pane = 1 }, cx)
	eq(#argv_lines(plugin, "list"), 1, "list runs in flight")
	plugin:answer("list", LISTED, 0, cx)
	eq(table.concat(argv_lines(plugin, "list"), ";"), "list --all", "run after the answer")
end)

test("command_finished outside the index starts no list", function()
	local plugin, cx = started("/home/u")
	plugin:tick(2000)
	plugin.handlers.command_finished({ pane = 1 }, cx)
	plugin:tick(2000)
	eq(#argv_lines(plugin, "list"), 0, "list runs")
end)

test("a cwd under the root that is not in the index starts a list, and one in the index does not", function()
	local plugin, cx = started("/home/u")
	plugin:tick(2000)
	plugin.handlers.cwd({ pane = 1, path = FEAT .. "/src" }, cx)
	eq(#argv_lines(plugin, "list"), 0, "list runs for a cwd in the index")
	plugin.handlers.cwd({ pane = 1, path = "/wt/worktrees/app/new" }, cx)
	eq(#argv_lines(plugin, "list"), 1, "list runs for a new worktree")
	plugin:answer("list", LISTED, 0, cx)
	plugin:tick(2000)
	plugin.handlers.cwd({ pane = 1, path = "/home/u/new" }, cx)
	eq(#argv_lines(plugin, "list"), 0, "list runs for a cwd outside the root")
end)

test(
	"a cwd into a new worktree after a list --all whose callback Tern dropped for 120 s starts one list --all",
	function()
		local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/home/u" } }, 1)
		local plugin = Stub.load({ env = ENV, kv = { worktreeRoot = ROOT } })
		plugin.handlers.window_start(cx)
		local dropped = table.remove(plugin.runs) :: Stub.Run
		eq(table.concat(dropped.argv, " ", 2), "list --all", "dropped run")
		dropped.cb({ stdout = LISTED, stderr = "", status = 0 }, nil)
		plugin:tick(120001)
		plugin.handlers.cwd({ pane = 1, path = "/wt/worktrees/app/new" }, cx)
		eq(table.concat(argv_lines(plugin, "list"), ";"), "list --all", "list runs after the cwd")
		plugin:answer("list", LISTED, 0, cx)
		dropped.cb({ stdout = '{"root":"/wt/worktrees","worktrees":[]}', stderr = "", status = 0 }, cx)
		eq(plugin.kv.worktreeIndex[FEAT].branch, "feat", "entry after the late answer of the dropped run")
		eq(#argv_lines(plugin, "list"), 0, "list runs after the late answer")
	end
)

for _, gap in { 10, 0 } do
	test(`an entry from a create answer {gap} ms after a list --all started survives its answer`, function()
		local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1, { fail = { new_tab = true } })
		local plugin = Stub.load({ env = ENV })
		plugin.handlers.window_start(cx)
		plugin:tick(gap)
		pick_branch_x(plugin, cx)
		plugin:answer("create", CREATED, 0, cx)
		plugin:answer("resolve", RESOLVED, 0, cx)
		plugin:answer("list", LISTED, 0, cx)
		eq(plugin.kv.worktreeIndex["/wt/worktrees/app/x"].branch, "x", "entry from the create answer")
		eq(plugin.kv.worktreeIndex[FEAT].branch, "feat", "entry from list")
	end)
end

test("list --all rows without a string path or repo write no index entry", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/home/u" } }, 1)
	local plugin = Stub.load({ env = ENV })
	plugin.handlers.window_start(cx)
	plugin:answer(
		"list",
		'{"root":"/wt/worktrees","worktrees":['
			.. '{"path":"/wt/worktrees/app/norepo","branch":"x","changed":0},'
			.. '{"path":5,"repo":"/r/app","branch":"y","changed":0},'
			.. '{"path":"/wt/worktrees/app/feat","repo":"/r/app","branch":"feat","changed":0}]}',
		0,
		cx
	)
	local stored = plugin.kv.worktreeIndex
	eq(stored["/wt/worktrees/app/norepo"], nil, "entry of the row without repo")
	eq(stored[5], nil, "entry of the row with a number path")
	eq(stored[FEAT].main, "/r/app", "entry of the well-formed row")
end)

test("a remove deletes the index entry", function()
	local plugin, cx = started(FEAT .. "/src")
	local call = { reply = function(_self: any, _res: any) end, fail = function(_self: any, _err: string) end }
	function call.wait(_self: any, _ms: number): any
		return nil
	end
	plugin.exports.remove(FEAT, nil, cx, call)
	plugin:answer("remove", REMOVED, 0, cx)
	eq(plugin.kv.worktreeIndex[FEAT], nil, "removed entry")
	eq(plugin.kv.worktreeIndex[OMP].main, "/r/app", "other entry")
end)

test("a teardown from the close-tab picker deletes the index entry", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = FEAT .. "/src" } }, 1)
	local plugin = Stub.load({ env = ENV, files = { [FEAT .. "/.git"] = "" } })
	plugin.handlers.window_start(cx)
	plugin:answer("list", LISTED, 0, cx)
	eq(plugin.overrides.close_tab(cx), true, "close_tab result")
	plugin:answer("config", CONFIG, 0, cx)
	for _, it in cx.asked[1].opts.items do
		if it.id == "teardown" then
			cx.asked[1].next(it, nil, cx)
		end
	end
	plugin:answer("remove", REMOVED, 0, cx)
	eq(plugin.kv.worktreeIndex[FEAT], nil, "removed entry")
end)

-- Starts a window over the shared `kv`, with a pane in /r/app, and answers its `list --all` with LISTED.
local function window_over(kv: { [string]: any }): (Stub.Harness, any)
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1, { fail = { new_tab = true } })
	local plugin = Stub.load({ env = ENV, kv = kv })
	plugin.handlers.window_start(cx)
	plugin:answer("list", LISTED, 0, cx)
	return plugin, cx
end

-- Creates the worktree of `branch` at `path` from the branch picker of the window that `plugin` loaded.
local function create_in(plugin: Stub.Harness, cx: any, branch: string, path: string)
	plugin.commands.new.run(cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	plugin:answer(
		"branches",
		`\{"name":"app","default":"main","branches":["{branch}"],"prs":[],"prsFailed":false,"worktrees":[],"warnings":[]}`,
		0,
		cx
	)
	local picker = cx.asked[#cx.asked]
	for _, it in picker.opts.items do
		if it.id == "b:" .. branch then
			picker.next(it, nil, cx)
		end
	end
	plugin:answer(
		"create",
		`\{"branch":"{branch}","carried":[],"owner":"tern","path":"{path}","repo":"/r/app","status":"created","warnings":[]}`,
		0,
		cx
	)
	plugin:answer("resolve", RESOLVED, 0, cx)
end

test("a create or remove in one window keeps the entries that another window wrote to kv", function()
	local X, Y = "/wt/worktrees/app/x", "/wt/worktrees/app/y"
	local kv: { [string]: any } = {}
	local a, cxA = window_over(kv)
	local b, cxB = window_over(kv)
	create_in(a, cxA, "x", X)
	create_in(b, cxB, "y", Y)
	eq(kv.worktreeIndex[X] ~= nil, true, "X in kv after B's create")
	eq(kv.worktreeIndex[Y] ~= nil, true, "Y in kv after B's create")
	local call = { reply = function(_self: any, _res: any) end, fail = function(_self: any, _err: string) end }
	function call.wait(_self: any, _ms: number): any
		return nil
	end
	b.exports.remove(FEAT, nil, cxB, call)
	b:answer("remove", REMOVED, 0, cxB)
	eq(kv.worktreeIndex[FEAT], nil, "FEAT in kv after B's remove")
	eq(kv.worktreeIndex[X] ~= nil, true, "X in kv after B's remove")
	local host = Stub.load({ file = "host.luau", env = ENV, kv = kv })
	local spawn: any = host.handlers.spawn
	local spec = spawn({ program = "/bin/zsh", args = { "-l" }, cwd = X .. "/src", env = {} })
	eq(spec ~= nil and spec.env.TERN_WT_PATH, X, "TERN_WT_PATH of a new shell in X")
end)

runner.finish()
