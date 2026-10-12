--!strict

local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local WORKTREE = "/wt/worktrees/app/feat"

-- Loads window.luau with WORKTREE as a worktree whose main checkout is /src/<mainRepo>.
local function load_worktree_of(mainRepo: string): Stub.Harness
	return Stub.load({
		env = { TERN_WT_HOME = "/wt", HOME = "/home/u" },
		files = { [WORKTREE .. "/.git"] = `gitdir: /src/{mainRepo}/.git/worktrees/feat\n` },
	})
end

test("close_tab asks once for the last tab on a managed worktree", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = WORKTREE .. "/src" } }, 1)
	local plugin = load_worktree_of("app")
	eq(plugin.overrides.close_tab(cx), true, "close_tab result")
	eq(#cx.asked, 1, "pickers and prompts opened")
	eq(cx.asked[1].kind, "pick", "request kind")
end)

test("close_tab does not ask about a worktree of another repository", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = WORKTREE .. "/src" } }, 1)
	local plugin = load_worktree_of("other")
	eq(plugin.overrides.close_tab(cx), false, "close_tab result")
	eq(#cx.asked, 0, "pickers and prompts opened")
end)

test("close_tab does not ask about a worktree that a pane in another tab still uses", function()
	local cx = Stub.cx({
		{ pane = 1, tab = 1, cwd = WORKTREE .. "/src" },
		{ pane = 2, tab = 2, cwd = WORKTREE },
	}, 1)
	local plugin = load_worktree_of("app")
	eq(plugin.overrides.close_tab(cx), false, "close_tab result")
	eq(#cx.asked, 0, "pickers and prompts opened")
end)

test("window_start reads the worktree root from the list output", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app/feat" } }, 1)
	local plugin = Stub.load({
		env = { HOME = "/home/u" },
		files = { ["/r/app/feat/.git"] = "gitdir: /src/app/.git/worktrees/feat\n" },
	})
	plugin.handlers.window_start(cx)
	plugin:answer("list", '{"root":"/r/","worktrees":[]}')
	eq(plugin.kv.worktreeRoot, "/r", "remembered worktree root")
	eq(plugin.overrides.close_tab(cx), true, "close_tab result")
	eq(#cx.asked, 1, "pickers and prompts opened")
end)

local ENV = { TERN_WT_HOME = "/wt", HOME = "/home/u" }
local FEAT = "/wt/worktrees/app/feat"
local OMP = "/wt/7-abc1234"
local LISTED = '{"root":"/wt/worktrees","worktrees":['
	.. '{"path":"/wt/worktrees/app/feat","repo":"/r/app","branch":"feat","dirty":true,"changed":3,"owner":"tern"},'
	.. '{"path":"/wt/7-abc1234","repo":"/r/app","branch":null,"dirty":false,"changed":0,"owner":"omp"}]}'
local RESOLVED = '{"repos":[{"dir":"/r/app","root":"/r/app","name":"app"}]}'
local BRANCHES = [[{"name":"app","default":"main","branches":["main","x"],"prs":[],"worktrees":[],"warnings":[]}]]
local CREATED =
	'{"branch":"x","carried":[],"path":"/wt/worktrees/app/x","repo":"/r/app","status":"created","warnings":[]}'

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
	local omp = plugin.kv.worktreeIndex[OMP]
	eq(omp.main, "/r/app", "main of the omp-owned worktree")
	eq(omp.branch, nil, "branch of the detached omp-owned worktree")
	eq(omp.changed, 0, "changed of the omp-owned worktree")
end)

test("a create answer writes the index entry before new_tab runs", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = Stub.load({ env = ENV })
	local seen: any = nil
	cx.layout.new_tab = function(_self: any, _opts: any): number?
		local stored = plugin.kv.worktreeIndex
		seen = if stored ~= nil then stored["/wt/worktrees/app/x"] else nil
		return nil
	end
	pick_branch_x(plugin, cx)
	plugin:answer("create", CREATED, 0, cx)
	eq(seen ~= nil, true, "entry written before new_tab")
	eq(seen.main, "/r/app", "main")
	eq(seen.branch, "x", "branch")
	eq(seen.changed, 0, "changed")
end)

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

for _, gap in { 10, 0 } do
	test(`an entry from open_tab {gap} ms after a list --all started survives its answer`, function()
		local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
		local plugin = Stub.load({ env = ENV })
		cx.layout.new_tab = function(_self: any, _opts: any): number?
			return nil
		end
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
	plugin:answer("remove", '{"removed":"/wt/worktrees/app/feat","branch":"feat","warnings":[]}', 0, cx)
	eq(plugin.kv.worktreeIndex[FEAT], nil, "removed entry")
	eq(plugin.kv.worktreeIndex[OMP].main, "/r/app", "other entry")
end)

test("a teardown from the close-tab picker deletes the index entry", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = FEAT .. "/src" } }, 1)
	local plugin = Stub.load({ env = ENV, files = { [FEAT .. "/.git"] = "gitdir: /r/app/.git/worktrees/feat\n" } })
	plugin.handlers.window_start(cx)
	plugin:answer("list", LISTED, 0, cx)
	eq(plugin.overrides.close_tab(cx), true, "close_tab result")
	for _, it in cx.asked[1].opts.items do
		if it.id == "teardown" then
			cx.asked[1].next(it, nil, cx)
		end
	end
	plugin:answer("remove", '{"removed":"/wt/worktrees/app/feat","branch":"feat","warnings":[]}', 0, cx)
	eq(plugin.kv.worktreeIndex[FEAT], nil, "removed entry")
end)

-- Starts a window over the shared `kv`, with a pane in /r/app, and answers its `list --all` with LISTED.
local function window_over(kv: { [string]: any }): (Stub.Harness, any)
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	cx.layout.new_tab = function(_self: any, _opts: any): number?
		return nil
	end
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
		`\{"name":"app","default":"main","branches":["{branch}"],"prs":[],"worktrees":[],"warnings":[]}`,
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
		`\{"branch":"{branch}","carried":[],"path":"{path}","repo":"/r/app","status":"created","warnings":[]}`,
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
	b:answer("remove", '{"removed":"/wt/worktrees/app/feat","branch":"feat","warnings":[]}', 0, cxB)
	eq(kv.worktreeIndex[FEAT], nil, "FEAT in kv after B's remove")
	eq(kv.worktreeIndex[X] ~= nil, true, "X in kv after B's remove")
	local host = Stub.load({ file = "host.luau", env = ENV, kv = kv })
	local spawn: any = host.handlers.spawn
	local spec = spawn({ program = "/bin/zsh", args = { "-l" }, cwd = X .. "/src", env = {} })
	eq(spec ~= nil and spec.env.TERN_WT_PATH, X, "TERN_WT_PATH of a new shell in X")
end)

runner.finish()
