--!strict

local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local ENV = { HOME = "/home/u" }
local PATH = "/wt/worktrees/app/x"
local LINE = "npm ci && npm test"
local RESOLVED = '{"repos":[{"dir":"/r/app","root":"/r/app","name":"app"}]}'
local HOME_RESOLVED = '{"repos":[{"dir":"/home/u","root":null,"name":null}]}'
local BRANCHES =
	[[{"name":"app","default":"main","branches":["main","x"],"prs":[],"prsFailed":false,"worktrees":[],"warnings":[]}]]
local CREATED =
	`\{"branch":"x","carried":[],"owner":"tern","path":"{PATH}","repo":"/r/app","setup":\{"line":"{LINE}","typed":false},"status":"created","warnings":[]}`
local ELSEWHERE =
	'{"error":{"code":"worktree_exists_elsewhere","message":"elsewhere","existing":"/old/app/x","target":"/wt/worktrees/app/x"}}'

local function argv_lines(plugin: Stub.Harness, verb: string): string
	local found: { string } = {}
	for _, run in plugin.runs do
		if run.argv[2] == verb then
			table.insert(found, table.concat(run.argv, " ", 2))
		end
	end
	return table.concat(found, "; ")
end

local function item_by_id(request: any, id: string): any
	for _, it in request.opts.items do
		if it.id == id then
			return it
		end
	end
	error("no item " .. id)
end

-- The titles of the toasts of `cx` after the first `skip` toasts, joined by "; ".
local function toast_titles(cx: any, skip: number): string
	local titles: { string } = {}
	for i = skip + 1, #cx.toasts do
		table.insert(titles, cx.toasts[i].title)
	end
	return table.concat(titles, "; ")
end

local function setup_toast_count(cx: any): number
	local count = 0
	for _, t in cx.toasts do
		if string.sub(t.title, 1, #"Setup not run") == "Setup not run" then
			count += 1
		end
	end
	return count
end

local function success_toast(cx: any): any
	for _, t in cx.toasts do
		if t.level == "success" then
			return t
		end
	end
	error("no success toast")
end

-- Moves the clock by `ms` in 200 ms steps, so each setup poll runs.
local function wait_ms(plugin: Stub.Harness, ms: number)
	for _ = 1, ms // 200 do
		plugin:tick(200)
	end
end

-- A window with pane 1 in /r/app plus `extra`.
local function window(extra: { Stub.Pane }?): (Stub.Harness, any)
	local panes: { Stub.Pane } = { { pane = 1, tab = 1, cwd = "/r/app" } }
	local more: { Stub.Pane } = extra or {}
	for _, p in more do
		table.insert(panes, p)
	end
	local cx = Stub.cx(panes, 1)
	return Stub.load({ env = ENV, cx = cx }), cx
end

-- Opens the branch picker of /r/app with the hotkey.
local function open_picker(plugin: Stub.Harness, cx: any): any
	plugin.commands.new.run(cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	return cx.asked[#cx.asked]
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

-- A Carly call that ignores its reply.
local function ignored_call(): any
	local call = { reply = function(_self: any, _res: any) end, fail = function(_self: any, _err: string) end }
	function call.wait(_self: any, _ms: number): any
		return nil
	end
	return call
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
	plugin:answer("create", CREATED, 0, cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	eq(#cx.records, 1, "sessions")
	eq(table.concat(cx.effects, "; "), "new_tab → tab 2, pane 2; name_tab 2 x", "effects")
end)

test("a create from the branch picker whose tab step raises still refreshes and toasts", function()
	local plugin, cx = window()
	cx.layout.new_tab = function(_self: any, _opts: any): number?
		error("no tab", 0)
	end
	local picker = open_picker(plugin, cx)
	picker.next(item_by_id(picker, "b:x"), nil, cx)
	plugin:answer("create", CREATED, 0, cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	eq(argv_lines(plugin, "branches"), "branches --repo /r/app --offline", "branches calls after the create")
	eq(success_toast(cx).detail, PATH .. " · tab not opened: no tab", "success toast detail")
	wait_ms(plugin, 31000)
	eq(#cx.typed, 0, "typed")
	eq(setup_toast_count(cx), 0, "setup toasts")
end)

-- Each create entry, run over a `window()` up to its pending `create`.
local ENTRIES: { { what: string, run: (plugin: Stub.Harness, cx: any) -> () } } = {
	{
		what = "the branch picker",
		run = function(plugin, cx)
			local picker = open_picker(plugin, cx)
			picker.next(item_by_id(picker, "b:x"), nil, cx)
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
			local picker = open_picker(plugin, cx)
			picker.next(item_by_id(picker, "b:x"), nil, cx)
			plugin:answer("create", ELSEWHERE, 1, cx)
			local relocate = cx.asked[#cx.asked]
			relocate.next(item_by_id(relocate, "relocate"), nil, cx)
		end,
	},
	{
		what = "New branch",
		run = function(plugin, cx)
			local picker = open_picker(plugin, cx)
			picker.next(item_by_id(picker, "new"), nil, cx)
			cx.asked[#cx.asked].next("x", nil, cx)
		end,
	},
	{
		what = "the Carly export",
		run = function(plugin, cx)
			plugin.exports.create("/r/app", "x", nil, cx, ignored_call())
		end,
	},
}

for _, entry in ENTRIES do
	test(`a create from {entry.what} resolves sessions once, after it writes the index entry`, function()
		local plugin, cx = window()
		entry.run(plugin, cx)
		eq(argv_lines(plugin, "create") ~= "", true, "create pending")
		eq(argv_lines(plugin, "resolve"), "", "resolve calls before the create answer")
		plugin:answer("create", CREATED, 0, cx)
		eq(argv_lines(plugin, "resolve"), "resolve /r/app", "resolve calls after the create answer")
		local indexed = (plugin.kv.worktreeIndex or {})[PATH]
		eq(indexed ~= nil and indexed.owner, "tern", "index entry owner before resolve answers")
		eq(#cx.effects, 0, "effects before resolve answers")
		plugin:answer("resolve", RESOLVED, 0, cx)
		eq(argv_lines(plugin, "resolve"), "", "resolve calls after resolve answers")
		eq(table.concat(cx.effects, "; "), "new_tab → tab 2, pane 2; name_tab 2 x", "effects")
	end)
end

test("a create whose setup cannot run shows the success toast first, then the setup toast, which stays", function()
	local plugin, cx = window({ { pane = 2, tab = 2, cwd = PATH, at_prompt = true } })
	local picker = open_picker(plugin, cx)
	local skip = #cx.toasts
	picker.next(item_by_id(picker, "b:x"), nil, cx)
	plugin:answer("create", CREATED, 0, cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	wait_ms(plugin, 31000)
	eq(
		toast_titles(cx, skip),
		"Creating worktree x…; Created\u{A0}worktree; Setup not run: the tab was open before",
		"toast titles"
	)
end)

runner.finish()
