--!strict

local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local ENV = { TERN_WT_HOME = "/wt", HOME = "/home/u" }
local PATH = "/wt/worktrees/app/x"
local LINE = "npm ci && npm test"
local RESOLVED = '{"repos":[{"dir":"/r/app","root":"/r/app","name":"app"}]}'
local BRANCHES = [[{"name":"app","default":"main","branches":["main","x"],"prs":[],"worktrees":[],"warnings":[]}]]
local NO_PROMPT = "setup not run: no shell prompt in 30 s"
local OPEN_BEFORE = "setup not run: the tab was open before"
local NO_TAB = "setup not run: no tab opened"
local NO_NEW_SHELL = "setup not run: no new shell in the tab"

-- The `create` answer for branch x, with `setup` as its JSON value.
local function created(setup: string): string
	return `\{"branch":"x","carried":[],"path":"{PATH}","repo":"/r/app","setup":{setup},"status":"created","warnings":[]}`
end

local UNTYPED = created(`\{"line":"{LINE}","typed":false}`)

-- A window with pane 1 in /r/app plus `extra`. Its `new_tab` opens shell pane 5 in tab 2, not yet at the prompt.
local function window(extra: { Stub.Pane }?): (Stub.Harness, any, { Stub.Pane })
	local panes: { Stub.Pane } = { { pane = 1, tab = 1, cwd = "/r/app" } }
	local more: { Stub.Pane } = extra or {}
	for _, p in more do
		table.insert(panes, p)
	end
	local cx = Stub.cx(panes, 1)
	cx.layout.new_tab = function(_self: any, opts: any): number?
		table.insert(panes, { pane = 5, tab = 2, cwd = opts.cwd, at_prompt = false })
		return 5
	end
	cx.layout.name_tab = function(_self: any, _tab: number, _name: string) end
	return Stub.load({ env = ENV, cx = cx }), cx, panes
end

-- Picks branch x in the branch picker and answers its `create` with `answer`.
local function create_x(plugin: Stub.Harness, cx: any, answer: string)
	plugin.commands.new.run(cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	local picker = cx.asked[#cx.asked]
	for _, it in picker.opts.items do
		if it.id == "b:x" then
			picker.next(it, nil, cx)
		end
	end
	plugin:answer("create", answer, 0, cx)
end

local function find_pane(panes: { Stub.Pane }, id: number): Stub.Pane
	for _, p in panes do
		if p.pane == id then
			return p
		end
	end
	error("no pane " .. id)
end

local function setup_toasts(cx: any): { any }
	local found: { any } = {}
	for _, t in cx.toasts do
		if string.sub(t.title, 1, #"setup not run") == "setup not run" then
			table.insert(found, t)
		end
	end
	return found
end

-- Moves the clock by `ms` in 200 ms steps, so each poll runs.
local function wait_ms(plugin: Stub.Harness, ms: number)
	for _ = 1, ms // 200 do
		plugin:tick(200)
	end
end

test("type_setup polls, then types the line once the shell is at its prompt", function()
	local plugin, cx, panes = window()
	create_x(plugin, cx, UNTYPED)
	eq(#cx.typed, 0, "typed before the prompt")
	plugin:tick(200)
	eq(#cx.typed, 0, "typed after one poll without a prompt")
	find_pane(panes, 5).at_prompt = true
	plugin:tick(200)
	eq(#cx.typed, 1, "typed at the prompt")
	eq(cx.typed[1].pane, 5, "typed pane")
	eq(cx.typed[1].text, LINE .. "\r", "typed text")
	wait_ms(plugin, 30000)
	eq(#cx.typed, 1, "typed once")
	eq(#setup_toasts(cx), 0, "setup toasts")
end)

test("type_setup toasts the line when no prompt shows in 30 s", function()
	local plugin, cx = window()
	create_x(plugin, cx, UNTYPED)
	wait_ms(plugin, 29800)
	eq(#setup_toasts(cx), 0, "setup toasts before 30 s")
	plugin:tick(200)
	local toasts = setup_toasts(cx)
	eq(#toasts, 1, "setup toasts at 30 s")
	eq(toasts[1].level, "error", "toast level")
	eq(toasts[1].title, NO_PROMPT, "toast title")
	eq(toasts[1].detail, LINE, "toast detail")
	wait_ms(plugin, 1000)
	eq(#setup_toasts(cx), 1, "setup toasts after 31 s")
	eq(#cx.typed, 0, "typed")
end)

for _, case in
	{
		{ what = "typed is true", setup = `\{"line":"{LINE}","typed":true}` },
		{ what = "setup is null", setup = "null" },
	}
do
	test(`type_setup does nothing when {case.what}`, function()
		local plugin, cx, panes = window()
		create_x(plugin, cx, created(case.setup))
		find_pane(panes, 5).at_prompt = true
		wait_ms(plugin, 31000)
		eq(#cx.typed, 0, "typed")
		eq(#setup_toasts(cx), 0, "setup toasts")
	end)
end

test("type_setup stops when the pane is gone", function()
	local plugin, cx, panes = window()
	create_x(plugin, cx, UNTYPED)
	local shell = find_pane(panes, 5)
	table.remove(panes, table.find(panes, shell))
	plugin:tick(200)
	shell.at_prompt = true
	table.insert(panes, shell)
	wait_ms(plugin, 31000)
	eq(#cx.typed, 0, "typed")
	eq(#setup_toasts(cx), 0, "setup toasts")
end)

test("type_setup stops when its timer gets no cx", function()
	local plugin, cx, panes = window()
	create_x(plugin, cx, UNTYPED)
	local polls = 0
	for i = #plugin.timers, 1, -1 do
		local timer = plugin.timers[i]
		if timer.at == 200 then
			polls += 1
			table.remove(plugin.timers, i)
			timer.fn(nil)
		end
	end
	eq(polls, 1, "pending polls")
	find_pane(panes, 5).at_prompt = true
	wait_ms(plugin, 31000)
	eq(#cx.typed, 0, "typed")
	eq(#setup_toasts(cx), 0, "setup toasts")
end)

test("a tab that was open before gets the open-before toast and no typing", function()
	local plugin, cx = window({ { pane = 2, tab = 2, cwd = PATH, at_prompt = true } })
	create_x(plugin, cx, UNTYPED)
	local toasts = setup_toasts(cx)
	eq(#toasts, 1, "setup toasts")
	eq(toasts[1].level, "error", "toast level")
	eq(toasts[1].title, OPEN_BEFORE, "toast title")
	eq(toasts[1].detail, LINE, "toast detail")
	wait_ms(plugin, 31000)
	eq(#cx.typed, 0, "typed")
end)

test("a create that opens no tab gets the no-tab toast and no typing", function()
	local plugin, cx = window()
	cx.layout.new_tab = function(_self: any, _opts: any): number?
		return nil
	end
	create_x(plugin, cx, UNTYPED)
	local toasts = setup_toasts(cx)
	eq(#toasts, 1, "setup toasts")
	eq(toasts[1].level, "error", "toast level")
	eq(toasts[1].title, NO_TAB, "toast title")
	eq(toasts[1].detail, LINE, "toast detail")
	wait_ms(plugin, 31000)
	eq(#cx.typed, 0, "typed")
end)

test("a parked pane moved into a new tab gets the no-new-shell toast and no typing", function()
	local plugin, cx, panes = window({ { pane = 3, cwd = PATH, parked = true, at_prompt = true } })
	cx.layout.unpark = function(_self: any, _pane: number): boolean
		return true
	end
	cx.layout.move_to_new_tab = function(_self: any, pane: number, _session: number?): number?
		find_pane(panes, pane).tab = 4
		find_pane(panes, pane).parked = false
		return 4
	end
	cx.sessions.create = function(_self: any, _opts: any): any
		return { id = 2, name = "app" }
	end
	create_x(plugin, cx, UNTYPED)
	local toasts = setup_toasts(cx)
	eq(#toasts, 1, "setup toasts")
	eq(toasts[1].title, NO_NEW_SHELL, "toast title")
	eq(toasts[1].detail, LINE, "toast detail")
	wait_ms(plugin, 31000)
	eq(#cx.typed, 0, "typed")
end)

test("the first tab of a new session gets the setup commands", function()
	local panes: { Stub.Pane } = { { pane = 1, tab = 1, cwd = "/r/other" } }
	local cx = Stub.cx(panes, 1)
	local opened = false
	cx.sessions.create = function(_self: any, opts: any): any
		opened = true
		table.insert(panes, { pane = 7, tab = 3, cwd = opts.cwd, at_prompt = true })
		return { id = 2, name = opts.name }
	end
	cx.session.sessions = function(_self: any): { any }
		local sessions = { { id = 1, name = "main", tabs = { 1 }, current = true } }
		if opened then
			table.insert(sessions, { id = 2, name = "app", tabs = { 3 }, current = false })
		end
		return sessions
	end
	cx.layout.name_tab = function(_self: any, _tab: number, _name: string) end
	local plugin = Stub.load({ env = ENV, cx = cx })
	local call = { reply = function(_self: any, _res: any) end, fail = function(_self: any, _err: string) end }
	function call.wait(_self: any, _ms: number): any
		return nil
	end
	plugin.exports.create("/r/app", "x", nil, cx, call)
	plugin:answer("create", UNTYPED, 0, cx)
	plugin:answer("resolve", '{"repos":[{"dir":"/r/other","root":"/r/other","name":"other"}]}', 0, cx)
	eq(opened, true, "session created")
	eq(#cx.typed, 1, "typed")
	eq(cx.typed[1].pane, 7, "typed pane")
	eq(cx.typed[1].text, LINE .. "\r", "typed text")
end)

test("a Carly create whose tab fails to open types nothing", function()
	local plugin, cx = window()
	cx.layout.new_tab = function(_self: any, _opts: any): number?
		error("no tab", 0)
	end
	local replied: any = nil
	local call = {
		reply = function(_self: any, res: any)
			replied = res
		end,
		fail = function(_self: any, _err: string) end,
	}
	function call.wait(_self: any, _ms: number): any
		return nil
	end
	plugin.exports.create("/r/app", "x", nil, cx, call)
	plugin:answer("create", UNTYPED, 0, cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	eq(replied ~= nil and replied.warnings[1], "tab not opened: no tab", "warning")
	wait_ms(plugin, 31000)
	eq(#cx.typed, 0, "typed")
	eq(#setup_toasts(cx), 0, "setup toasts")
end)

-- Runs the Carly `create` export for branch x in a `window()`, and returns the list of its replies.
local function carly_create(plugin: Stub.Harness, cx: any): { any }
	local replies: { any } = {}
	local call = {
		reply = function(_self: any, res: any)
			table.insert(replies, res)
		end,
		fail = function(_self: any, err: string)
			error("call:fail " .. err, 0)
		end,
	}
	function call.wait(_self: any, _ms: number): any
		return nil
	end
	plugin.exports.create("/r/app", "x", nil, cx, call)
	plugin:answer("create", UNTYPED, 0, cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	return replies
end

test("a Carly create replies typed = true after the tick that types the line", function()
	local plugin, cx, panes = window()
	local replies = carly_create(plugin, cx)
	plugin:tick(200)
	eq(#replies, 0, "replies before the prompt")
	find_pane(panes, 5).at_prompt = true
	plugin:tick(200)
	eq(#cx.typed, 1, "typed")
	eq(#replies, 1, "replies after the prompt")
	eq(replies[1].setup.line, LINE, "setup line")
	eq(replies[1].setup.typed, true, "setup typed")
	eq(#replies[1].warnings, 0, "warnings")
	wait_ms(plugin, 31000)
	eq(#replies, 1, "replies at the end")
end)

test("a Carly create replies typed = false with the warning when no prompt shows in 30 s", function()
	local plugin, cx = window()
	local replies = carly_create(plugin, cx)
	wait_ms(plugin, 29800)
	eq(#replies, 0, "replies before 30 s")
	plugin:tick(200)
	eq(#replies, 1, "replies at 30 s")
	eq(replies[1].setup.typed, false, "setup typed")
	eq(replies[1].warnings[1], NO_PROMPT, "warning")
	eq(#cx.typed, 0, "typed")
end)

test("a Carly create replies typed = false with no warning when the pane is gone", function()
	local plugin, cx, panes = window()
	local replies = carly_create(plugin, cx)
	table.remove(panes, table.find(panes, find_pane(panes, 5)))
	plugin:tick(200)
	eq(#replies, 1, "replies")
	eq(replies[1].setup.typed, false, "setup typed")
	eq(#replies[1].warnings, 0, "warnings")
	wait_ms(plugin, 31000)
	eq(#replies, 1, "replies at the end")
end)

test("a Carly create into a tab that was open before replies at once with the warning", function()
	local plugin, cx = window({ { pane = 2, tab = 2, cwd = PATH, at_prompt = true } })
	local replies = carly_create(plugin, cx)
	eq(#replies, 1, "replies")
	eq(replies[1].setup.typed, false, "setup typed")
	eq(replies[1].warnings[1], OPEN_BEFORE, "warning")
	eq(#cx.typed, 0, "typed")
end)

test("a Carly create that opens no tab replies at once with the no-tab warning", function()
	local plugin, cx = window()
	cx.layout.new_tab = function(_self: any, _opts: any): number?
		return nil
	end
	local replies = carly_create(plugin, cx)
	eq(#replies, 1, "replies")
	eq(replies[1].setup.typed, false, "setup typed")
	eq(replies[1].warnings[1], NO_TAB, "warning")
	wait_ms(plugin, 31000)
	eq(#cx.typed, 0, "typed")
end)

runner.finish()
