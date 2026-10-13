--!strict

local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local ENV = { HOME = "/home/u" }
local NEW = "plugin.tern-worktrees.new"
local FEAT = "/wt/worktrees/app/feat"
local OMP = "/wt/7-abc1234"

-- A `list --all` answer with the given rows, each `{path, branch, changed, owner}`. A nil branch means a detached
-- `HEAD`. Each row is a copy of the first worktree of the `list-all` fixture, with these values set.
local function listed(rows: { { any } }): string
	local vars = { root = "/wt/worktrees", repo = "/r/app", feat = FEAT, omp = OMP }
	return Stub.answer("list-all", vars, function(answer: any)
		local entry = answer.worktrees[1]
		local items: { any } = {}
		for _, row in rows do
			local item = table.clone(entry)
			item.path, item.branch, item.changed, item.dirty, item.owner = row[1], row[2], row[3], row[3] > 0, row[4]
			table.insert(items, item)
		end
		answer.worktrees = items
	end)
end

local LISTED = listed({
	{ FEAT, "feat", 2, "tern" },
	{ OMP, "omp/fix", 1, "omp" },
	{ "/wt/worktrees/app/clean", "clean", 0, "tern" },
	{ "/wt/8-def5678", nil, 0, "omp" },
})

-- Starts a window with one pane in `cwd` (default FEAT/src), and answers its `list --all` with `answer`.
local function started(answer: string, cwd: string?): (Stub.Harness, any)
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = cwd or FEAT .. "/src" } }, 1, { fail = { new_tab = true } })
	local plugin = Stub.load({ env = ENV })
	plugin.handlers.window_start(cx)
	plugin:answer("list", answer, 0, cx)
	return plugin, cx
end

-- The one segment the formatter gives for `cwd`.
local function segment_of(plugin: Stub.Harness, cwd: string): any
	local segments = plugin:status(cwd)
	eq(segments ~= nil and #segments, 1, `segments for {cwd}`)
	return segments[1]
end

test("a managed worktree shows its branch and its number of changed files", function()
	local plugin = started(LISTED)
	local seg = segment_of(plugin, FEAT)
	eq(seg.text, "feat · 2", "text")
	eq(seg.icon, "branch", "icon")
	eq(seg.tone, "warn", "tone")
	eq(seg.command, NEW, "command")
end)

test("an omp-owned worktree shows its branch and its number of changed files", function()
	local plugin = started(LISTED)
	local seg = segment_of(plugin, OMP)
	eq(seg.text, "omp/fix · 1", "text")
	eq(seg.icon, "branch", "icon")
	eq(seg.tone, "warn", "tone")
	eq(seg.command, NEW, "command")
end)

test("a worktree without changed files shows its branch alone, muted", function()
	local plugin = started(LISTED)
	local clean = segment_of(plugin, "/wt/worktrees/app/clean")
	eq(clean.text, "clean", "text of the clean worktree")
	eq(clean.tone, "muted", "tone of the clean worktree")
	local detached = segment_of(plugin, "/wt/8-def5678")
	eq(detached.text, "detached", "text of the detached worktree")
	eq(detached.tone, "muted", "tone of the detached worktree")
end)

test("the formatter never calls refresh", function()
	local plugin = started(LISTED)
	local before = plugin.refreshes
	for _, cwd in { FEAT, FEAT .. "/src", OMP, "/wt/8-def5678", "/home/u" } do
		plugin:status(cwd)
	end
	eq(plugin.refreshes, before, "refreshes while formatting")
end)

test("refresh runs once after list --all adds the first entries", function()
	local plugin = started(LISTED)
	eq(plugin.refreshes, 1, "refreshes")
end)

local ONCE, NEVER = { count = 1, word = "once" }, { count = 0, word = "never" }

for _, case in
	{
		{ what = "a count change", refresh = ONCE, rows = { { FEAT, "feat", 3, "tern" } } },
		{ what = "a branch change", refresh = ONCE, rows = { { FEAT, "other", 2, "tern" } } },
		{
			what = "an added entry",
			refresh = ONCE,
			rows = { { FEAT, "feat", 2, "tern" }, { "/wt/worktrees/app/new", "new", 0, "tern" } },
		},
		{ what = "a removed entry", refresh = ONCE, rows = {} },
		{ what = "an identical index", refresh = NEVER, rows = { { FEAT, "feat", 2, "tern" } } },
	} :: { { what: string, refresh: { count: number, word: string }, rows: { { any } } } }
do
	test(`refresh runs {case.refresh.word} after {case.what} in list --all`, function()
		local plugin, cx = started(listed({ { FEAT, "feat", 2, "tern" } }))
		local before = plugin.refreshes
		plugin:tick(2000)
		plugin.handlers.command_finished({ pane = 1 }, cx)
		plugin:answer("list", listed(case.rows), 0, cx)
		eq(plugin.refreshes - before, case.refresh.count, "refreshes")
	end)
end

test("refresh runs once after a create adds an entry", function()
	local plugin, cx = started(LISTED, "/r/app")
	plugin.commands.new.run(cx)
	plugin:answer("resolve", Stub.fixture("resolve", { repo = "/r/app" }), 0, cx)
	plugin:answer("branches", Stub.fixture("branches-offline", { repo = "/r/app" }), 0, cx)
	local picker = cx.asked[#cx.asked]
	picker.next(Stub.item(picker, "b:x"), nil, cx)
	eq(#plugin.runs > 0 and plugin.runs[#plugin.runs].argv[2], "create", "pending CLI call")
	local before = plugin.refreshes
	plugin:answer("create", Stub.fixture("create-created", Stub.worktree_vars("x")), 0, cx)
	eq(plugin.refreshes - before, 1, "refreshes")
	eq(segment_of(plugin, "/wt/worktrees/app/x").text, "x", "text in the new worktree")
end)

for _, case in
	{
		{ what = "a worktree in the index", path = FEAT, refresh = ONCE },
		{ what = "a path the index lacks", path = "/wt/worktrees/app/gone", refresh = NEVER },
	}
do
	test(`refresh runs {case.refresh.word} after a remove of {case.what}`, function()
		local plugin, cx = started(LISTED)
		local call = Stub.call()
		local before = plugin.refreshes
		plugin.exports.remove(case.path, nil, cx, call)
		local removed = Stub.answer(
			"remove-kept-policy",
			{ repo = "/r/app", worktree = case.path },
			{ branch = "feat" }
		)
		plugin:answer("remove", removed, 0, cx)
		eq(plugin.refreshes - before, case.refresh.count, "refreshes")
	end)
end

runner.finish()
