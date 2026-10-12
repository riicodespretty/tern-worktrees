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
	test(`an entry from open_tab {gap} ms after a list --all started survives its answer`, function()
		local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1, { fail = { new_tab = true } })
		local plugin = Stub.load({ env = ENV })
		plugin.handlers.window_start(cx)
		plugin:tick(gap)
		pick_branch_x(plugin, cx)
		plugin:answer("create", CREATED, 0, cx)
		plugin:answer("list", LISTED, 0, cx)
		eq(plugin.kv.worktreeIndex["/wt/worktrees/app/x"].branch, "x", "entry from open_tab")
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
