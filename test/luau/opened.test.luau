--!strict

local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local ENV = { HOME = "/home/u" }
local PATH = "/wt/worktrees/app/x"
local RESOLVED = Stub.fixture("resolve", { repo = "/r/app" })
-- The `resolve` answer of the CLI for /home/u, a dir in no repository.
local HOME_RESOLVED = Stub.answer("resolve", { repo = "/home/u" }, function(answer: any)
	answer.repos[1].root, answer.repos[1].name = nil, nil
end)
local BRANCHES = Stub.fixture("branches-offline", { repo = "/r/app" })
-- The `create` answer for branch x, with an untyped setup line.
local CREATED = Stub.fixture("create-setup-no-tab", Stub.worktree_vars("x"))
local ELSEWHERE =
	Stub.fixture("create-elsewhere", { branch = "x", existing = "/old/app/x", target = "/wt/worktrees/app/x" })

-- The titles of the toasts of `cx` after the first `skip` toasts, joined by "; ".
local function toast_titles(cx: any, skip: number): string
	local titles: { string } = {}
	for i = skip + 1, #cx.toasts do
		table.insert(titles, cx.toasts[i].title)
	end
	return table.concat(titles, "; ")
end

local function success_toast(cx: any): any
	for _, t in cx.toasts do
		if t.level == "success" then
			return t
		end
	end
	error("no success toast")
end

-- The worktree row with `title`.
local function row(plugin: Stub.Harness, title: string): any
	for _, spec in plugin.commands do
		if spec.group == "Worktrees" and spec.title == title then
			return spec
		end
	end
	error("no row " .. title)
end

test("a worktree row of a repository first seen after window start opens its tab in that session", function()
	local panes: { Stub.Pane } = { { pane = 1, tab = 1, cwd = "/home/u" } }
	local cx = Stub.cx(panes, 1)
	local plugin = Stub.load({ env = ENV, cx = cx })
	plugin.handlers.window_start(cx)
	plugin:answer("resolve", HOME_RESOLVED, 0, cx)
	panes[1].cwd = "/r/app"
	plugin.handlers.cwd({ pane = 1, path = "/r/app" }, cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	row(plugin, "app: x").run(cx)
	plugin:created(cx, CREATED)
	eq(#cx.records, 1, "sessions")
	eq(table.concat(cx.effects, "; "), "new_tab → tab 2, pane 2; name_tab 2 x", "effects")
end)

test("a create from the branch picker whose tab step raises still refreshes and toasts", function()
	local plugin, cx = Stub.window()
	cx.layout.new_tab = function(_self: any, _opts: any): number?
		error("no tab", 0)
	end
	plugin:pick_branch(cx, "b:x", BRANCHES)
	plugin:created(cx, CREATED)
	eq(plugin:pending_line("branches"), "branches --repo /r/app --offline", "branches calls after the create")
	eq(success_toast(cx).detail, PATH .. " · tab not opened: no tab", "success toast detail")
	plugin:tick(31000)
	eq(#cx.typed, 0, "typed")
	eq(#Stub.setup_toasts(cx), 0, "setup toasts")
end)

-- Each create entry, run over a `Stub.window()` up to its pending `create`.
local ENTRIES: { { what: string, run: (plugin: Stub.Harness, cx: any) -> () } } = {
	{
		what = "the branch picker",
		run = function(plugin, cx)
			plugin:pick_branch(cx, "b:x", BRANCHES)
		end,
	},
	{
		what = "a worktree row",
		run = function(plugin, cx)
			plugin.handlers.cwd({ pane = 1, path = "/r/app" }, cx)
			plugin:answer("resolve", RESOLVED, 0, cx)
			plugin:answer("branches", BRANCHES, 0, cx)
			row(plugin, "app: x").run(cx)
		end,
	},
	{
		what = "Relocate",
		run = function(plugin, cx)
			plugin:pick_branch(cx, "b:x", BRANCHES)
			plugin:answer("create", ELSEWHERE, 1, cx)
			local relocate = cx.asked[#cx.asked]
			relocate.next(Stub.item(relocate, "relocate"), nil, cx)
		end,
	},
	{
		what = "New branch",
		run = function(plugin, cx)
			local picker = plugin:open_branch_picker(cx, BRANCHES)
			picker.next(Stub.item(picker, "new"), nil, cx)
			cx.asked[#cx.asked].next("x", nil, cx)
		end,
	},
	{
		what = "the Carly export",
		run = function(plugin, cx)
			plugin.exports.create("/r/app", "x", nil, cx, Stub.call())
		end,
	},
}

for _, entry in ENTRIES do
	test(`a create from {entry.what} resolves sessions once, after it writes the index entry`, function()
		local plugin, cx = Stub.window()
		entry.run(plugin, cx)
		eq(plugin:pending_line("create") ~= "", true, "create pending")
		eq(plugin:pending_line("resolve"), "", "resolve calls before the create answer")
		plugin:answer("create", CREATED, 0, cx)
		eq(plugin:pending_line("resolve"), "resolve /r/app", "resolve calls after the create answer")
		local indexed = (plugin.kv.worktreeIndex or {})[PATH]
		eq(indexed ~= nil and indexed.owner, "tern", "index entry owner before resolve answers")
		eq(#cx.effects, 0, "effects before resolve answers")
		plugin:answer("resolve", RESOLVED, 0, cx)
		eq(plugin:pending_line("resolve"), "", "resolve calls after resolve answers")
		eq(table.concat(cx.effects, "; "), "new_tab → tab 2, pane 2; name_tab 2 x", "effects")
	end)
end

test("a create whose setup cannot run shows the success toast first, then the setup toast, which stays", function()
	local plugin, cx = Stub.window({ extra = { { pane = 2, tab = 2, cwd = PATH, at_prompt = true } } })
	local picker = plugin:open_branch_picker(cx, BRANCHES)
	local skip = #cx.toasts
	picker.next(Stub.item(picker, "b:x"), nil, cx)
	plugin:created(cx, CREATED)
	plugin:tick(31000)
	eq(
		toast_titles(cx, skip),
		"Creating worktree x…; Created\u{A0}worktree; Setup not run: the tab was open before",
		"toast titles"
	)
end)

runner.finish()
