--!strict

local serde = require("@lune/serde")
local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local PATH = "/wt/worktrees/app/x"
local LINE = "npm ci && npm test"
local BRANCHES = Stub.fixture("branches-offline", { repo = "/r/app" })
local CREATE_VARS = Stub.worktree_vars("x")

-- The first warning of the `create` contract fixture `name`: the CLI words for a setup that did not run.
local function setup_warning(name: string): string
	return serde.decode("json", Stub.fixture(name, CREATE_VARS)).warnings[1]
end

local NO_PROMPT = setup_warning("create-setup-no-prompt")
local OPEN_BEFORE = setup_warning("create-setup-open-before")
local NO_TAB = "setup not run: no tab opened"

-- The `create` answer for branch x. Its setup line is LINE, from the fixture, and is not typed.
local UNTYPED = Stub.fixture("create-setup-no-tab", CREATE_VARS)

-- The shell pane of the new tab that a create opens in a `Stub.window()`, not yet at the prompt.
local SHELL = 2

-- Picks branch x in the branch picker, answers its `create` with `answer`, then answers the `resolve` of the create.
local function create_x(plugin: Stub.Harness, cx: any, answer: string)
	plugin:pick_branch(cx, "b:x", BRANCHES)
	plugin:answer_create(cx, answer)
end

local function find_pane(panes: { Stub.Pane }, id: number): Stub.Pane
	for _, p in panes do
		if p.pane == id then
			return p
		end
	end
	error("no pane " .. id)
end

test("type_setup polls, then types the line once the shell is at its prompt", function()
	local plugin, cx, panes = Stub.window()
	create_x(plugin, cx, UNTYPED)
	eq(#cx.typed, 0, "typed before the prompt")
	plugin:tick(200)
	eq(#cx.typed, 0, "typed after one poll without a prompt")
	find_pane(panes, SHELL).at_prompt = true
	plugin:tick(200)
	eq(#cx.typed, 1, "typed at the prompt")
	eq(cx.typed[1].pane, SHELL, "typed pane")
	eq(cx.typed[1].text, LINE .. "\r", "typed text")
	plugin:tick(30000)
	eq(#cx.typed, 1, "typed once")
	eq(#Stub.setup_toasts(cx), 0, "setup toasts")
end)

test("type_setup toasts the line when no prompt shows in 30 s", function()
	local plugin, cx = Stub.window()
	create_x(plugin, cx, UNTYPED)
	plugin:tick(29800)
	eq(#Stub.setup_toasts(cx), 0, "setup toasts before 30 s")
	plugin:tick(200)
	local toasts = Stub.setup_toasts(cx)
	eq(#toasts, 1, "setup toasts at 30 s")
	eq(toasts[1].level, "error", "toast level")
	eq(toasts[1].title, "Setup not run: no shell prompt in 30 s", "toast title")
	eq(toasts[1].detail, LINE, "toast detail")
	plugin:tick(1000)
	eq(#Stub.setup_toasts(cx), 1, "setup toasts after 31 s")
	eq(#cx.typed, 0, "typed")
end)

test("one tick of 31 s runs each setup poll on time, so the setup toast shows at 30 s", function()
	local plugin, cx = Stub.window()
	create_x(plugin, cx, UNTYPED)
	local toast = cx.toast
	local toast_clocks: { number } = {}
	cx.toast = function(self: any, level: string, title: string, detail: string?)
		if string.sub(title, 1, #"Setup not run") == "Setup not run" then
			table.insert(toast_clocks, plugin.clock)
		end
		toast(self, level, title, detail)
	end
	plugin:tick(31000)
	eq(#toast_clocks, 1, "setup toasts")
	eq(toast_clocks[1], 30000, "clock of the setup toast")
end)

test("a create whose setup is null types nothing and shows no setup toast", function()
	local plugin, cx, panes = Stub.window()
	create_x(plugin, cx, Stub.fixture("create-created", CREATE_VARS))
	find_pane(panes, SHELL).at_prompt = true
	plugin:tick(31000)
	eq(#cx.typed, 0, "typed")
	eq(#Stub.setup_toasts(cx), 0, "setup toasts")
end)

test("type_setup stops when the pane is gone", function()
	local plugin, cx, panes = Stub.window()
	create_x(plugin, cx, UNTYPED)
	local shell = find_pane(panes, SHELL)
	table.remove(panes, table.find(panes, shell))
	plugin:tick(200)
	shell.at_prompt = true
	table.insert(panes, shell)
	plugin:tick(31000)
	eq(#cx.typed, 0, "typed")
	eq(#Stub.setup_toasts(cx), 0, "setup toasts")
end)

test("type_setup stops when its timer gets no cx", function()
	local plugin, cx, panes = Stub.window()
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
	find_pane(panes, SHELL).at_prompt = true
	plugin:tick(31000)
	eq(#cx.typed, 0, "typed")
	eq(#Stub.setup_toasts(cx), 0, "setup toasts")
end)

test("a tab that was open before gets the open-before toast and no typing", function()
	local plugin, cx = Stub.window({ extra = { { pane = 2, tab = 2, cwd = PATH, at_prompt = true } } })
	create_x(plugin, cx, UNTYPED)
	local toasts = Stub.setup_toasts(cx)
	eq(#toasts, 1, "setup toasts")
	eq(toasts[1].level, "error", "toast level")
	eq(toasts[1].title, "Setup not run: the tab was open before", "toast title")
	eq(toasts[1].detail, LINE, "toast detail")
	plugin:tick(31000)
	eq(#cx.typed, 0, "typed")
end)

test("a create that opens no tab gets the no-tab toast and no typing", function()
	local plugin, cx = Stub.window({ fail = { new_tab = true } })
	create_x(plugin, cx, UNTYPED)
	local toasts = Stub.setup_toasts(cx)
	eq(#toasts, 1, "setup toasts")
	eq(toasts[1].level, "error", "toast level")
	eq(toasts[1].title, "Setup not run: no tab opened", "toast title")
	eq(toasts[1].detail, LINE, "toast detail")
	plugin:tick(31000)
	eq(#cx.typed, 0, "typed")
end)

test("a Carly create whose tab fails to open types nothing", function()
	local plugin, cx = Stub.window()
	cx.layout.new_tab = function(_self: any, _opts: any): number?
		error("no tab", 0)
	end
	local call = Stub.call()
	plugin.exports.create("/r/app", "x", nil, cx, call)
	plugin:answer_create(cx, UNTYPED)
	local replied = call.replies[1]
	eq(replied ~= nil and replied.warnings[1], "tab not opened: no tab", "warning")
	plugin:tick(31000)
	eq(#cx.typed, 0, "typed")
	eq(#Stub.setup_toasts(cx), 0, "setup toasts")
end)

-- Runs the Carly `create` export for branch x in a `Stub.window()`, and returns the list of its replies.
local function carly_create(plugin: Stub.Harness, cx: any): { any }
	local call = Stub.call()
	plugin.exports.create("/r/app", "x", nil, cx, call)
	plugin:answer_create(cx, UNTYPED)
	return call.replies
end

test("a Carly create replies typed = true after the tick that types the line", function()
	local plugin, cx, panes = Stub.window()
	local replies = carly_create(plugin, cx)
	plugin:tick(200)
	eq(#replies, 0, "replies before the prompt")
	find_pane(panes, SHELL).at_prompt = true
	plugin:tick(200)
	eq(#cx.typed, 1, "typed")
	eq(#replies, 1, "replies after the prompt")
	eq(replies[1].setup.line, LINE, "setup line")
	eq(replies[1].setup.typed, true, "setup typed")
	eq(#replies[1].warnings, 0, "warnings")
	plugin:tick(31000)
	eq(#replies, 1, "replies at the end")
end)

test("a Carly create replies typed = false with the warning when no prompt shows in 30 s", function()
	local plugin, cx = Stub.window()
	local replies = carly_create(plugin, cx)
	plugin:tick(29800)
	eq(#replies, 0, "replies before 30 s")
	plugin:tick(200)
	eq(#replies, 1, "replies at 30 s")
	eq(replies[1].setup.typed, false, "setup typed")
	eq(replies[1].warnings[1], NO_PROMPT, "warning")
	eq(#cx.typed, 0, "typed")
end)

test("a Carly create replies typed = false with no warning when the pane is gone", function()
	local plugin, cx, panes = Stub.window()
	local replies = carly_create(plugin, cx)
	table.remove(panes, table.find(panes, find_pane(panes, SHELL)))
	plugin:tick(200)
	eq(#replies, 1, "replies")
	eq(replies[1].setup.typed, false, "setup typed")
	eq(#replies[1].warnings, 0, "warnings")
	plugin:tick(31000)
	eq(#replies, 1, "replies at the end")
end)

test("a Carly create into a tab that was open before replies at once with the warning", function()
	local plugin, cx = Stub.window({ extra = { { pane = 2, tab = 2, cwd = PATH, at_prompt = true } } })
	local replies = carly_create(plugin, cx)
	eq(#replies, 1, "replies")
	eq(replies[1].setup.typed, false, "setup typed")
	eq(replies[1].warnings[1], OPEN_BEFORE, "warning")
	eq(#cx.typed, 0, "typed")
end)

test("a Carly create that opens no tab replies at once with the no-tab warning", function()
	local plugin, cx = Stub.window({ fail = { new_tab = true } })
	local replies = carly_create(plugin, cx)
	eq(#replies, 1, "replies")
	eq(replies[1].setup.typed, false, "setup typed")
	eq(replies[1].warnings[1], NO_TAB, "warning")
	plugin:tick(31000)
	eq(#cx.typed, 0, "typed")
end)

local function create_toast(cx: any): any
	for _, t in cx.toasts do
		if t.level == "success" then
			return t
		end
	end
	error("no create toast")
end

test("a create toast starts its title with a capital and keeps a short path whole", function()
	local plugin, cx = Stub.window()
	create_x(
		plugin,
		cx,
		`\{"branch":"x","carried":[],"owner":"tern","path":"{PATH}","repo":"/r/app","setup":null,"status":"reused","warnings":[]}`
	)
	local toast = create_toast(cx)
	eq(toast.title, "Reused\u{A0}worktree", "title")
	eq(toast.detail, PATH, "detail")
end)

test("a create toast cuts a long detail at its start and keeps its end", function()
	local plugin, cx = Stub.window()
	local long = "/wt/worktrees/app/" .. string.rep("very-long-folder-", 4) .. "end"
	create_x(
		plugin,
		cx,
		`\{"branch":"x","carried":[],"owner":"tern","path":"{long}","repo":"/r/app","setup":null,"status":"reused","warnings":[]}`
	)
	local detail = create_toast(cx).detail
	eq(utf8.len(detail), 50, "detail length")
	eq(string.sub(detail, 1, #"…"), "…", "detail start")
	eq(string.sub(detail, -#"folder-end"), "folder-end", "detail end")
end)

runner.finish()
