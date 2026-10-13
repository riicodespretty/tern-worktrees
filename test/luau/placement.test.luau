--!strict

local serde = require("@lune/serde")
local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local ENV = { HOME = "/home/u" }
local NO_SHELL = "setup not run: no new shell in the tab"

-- The `resolve` answer for each folder of the tests: /r/app and its worktrees are in the repository /r/app.
local RESOLVED = serde.encode("json", {
	repos = {
		{ dir = "/r/app", root = "/r/app", name = "app" },
		{ dir = "/r/app/src", root = "/r/app", name = "app" },
		{ dir = "/r/app/.wt/z", root = "/r/app", name = "app" },
		{ dir = "/r/other", root = "/r/other", name = "other" },
		{ dir = "/o/app-w", root = "/r/app", name = "app" },
		{ dir = "/wt/worktrees/app/x", root = "/r/app", name = "app" },
		{ dir = "/wt/worktrees/app/y", root = "/r/app", name = "app" },
	},
})

local function worktree(branch: string): string
	return "/wt/worktrees/app/" .. branch
end

-- The `create` answer for `branch` of /r/app, with an untyped setup line.
local function created(branch: string): string
	return Stub.answer("create-setup-no-tab", { branch = branch, repo = "/r/app", worktree = worktree(branch) })
end

-- Runs the Carly `create` of `branch` (default x) over `cx`, answers `create` and `resolve`, and returns the replies.
local function carly_create(plugin: Stub.Harness, cx: any, branch: string?): { any }
	local name = branch or "x"
	local call = Stub.call()
	plugin.exports.create("/r/app", name, nil, cx, call)
	plugin:answer("create", created(name), 0, cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	return call.replies
end

-- Runs the hotkey over `cx` and answers its `resolve`, so that the plugin reads the session of each repository.
local function press_hotkey(plugin: Stub.Harness, cx: any)
	plugin.commands.new.run(cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
end

local function effects(cx: any): string
	return table.concat(cx.effects, "; ")
end

local function find_pane(cx: any, id: number): Stub.Pane
	for _, p in cx.session:panes() do
		if p.pane == id then
			return p
		end
	end
	error("no pane " .. id)
end

-- The id of the session that holds `tab`, or nil.
local function session_of_tab(cx: any, tab: number?): number?
	for _, s in cx.session:sessions() do
		if table.find(s.tabs, tab) ~= nil then
			return s.id
		end
	end
	return nil
end

-- The tabs of session `id`, joined with commas.
local function tabs_of(cx: any, id: number): string
	for _, s in cx.session:sessions() do
		if s.id == id then
			return table.concat(s.tabs, ",")
		end
	end
	error("no session " .. id)
end

-- Sets the shell `pane` at its prompt and runs the setup poll.
local function prompt_in(plugin: Stub.Harness, cx: any, pane: number)
	find_pane(cx, pane).at_prompt = true
	plugin:tick(200)
end

local function setup_toast_titles(cx: any): string
	local titles: { string } = {}
	for _, t in cx.toasts do
		if string.sub(t.title, 1, #"Setup not run") == "Setup not run" then
			table.insert(titles, t.title)
		end
	end
	return table.concat(titles, "; ")
end

test("a worktree with a tab in the current session gets focus, no switch and no name", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" }, { pane = 2, tab = 2, cwd = worktree("x") } }, 1)
	local plugin = Stub.load({ env = ENV, cx = cx })
	local replies = carly_create(plugin, cx)
	eq(effects(cx), "focus 2", "effects")
	eq(cx.focused, 2, "focused")
	eq(next(cx.names), nil, "tab names")
	eq(replies[1].warnings[1], "setup not run: the tab was open before", "warning")
	eq(setup_toast_titles(cx), "Setup not run: the tab was open before", "setup toasts")
end)

test("a worktree with a tab in a different session switches to it, then focuses the tab", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/other" }, { pane = 2, tab = 2, cwd = worktree("x") } }, 1, {
		sessions = { { id = 1, name = "other", tabs = { 1 } }, { id = 2, name = "app", tabs = { 2 } } },
	})
	local plugin = Stub.load({ env = ENV, cx = cx })
	carly_create(plugin, cx)
	eq(effects(cx), "switch 2; focus 2", "effects")
	eq(cx.current, 2, "current session")
	eq(cx.focused, 2, "focused")
end)

-- With no current session (`current` is an id that no session has), a tab that was open before gets no switch, and
-- a new tab switches to the repository session first.
for _, case in
	{
		{ what = "a worktree with a tab gets no switch", worktree = true, effects = "focus 2" },
		{
			what = "a new tab switches to the repository session",
			worktree = false,
			effects = "switch 1; new_tab → tab 2, pane 2; name_tab 2 x",
		},
	}
do
	test(`with no current session, {case.what}`, function()
		local panes: { Stub.Pane } = { { pane = 1, tab = 1, cwd = "/r/app" } }
		local sessions: { Stub.SessionRecord } = { { id = 1, name = "app", tabs = { 1 } } }
		if case.worktree then
			table.insert(panes, { pane = 2, tab = 2, cwd = worktree("x") })
			table.insert(sessions, { id = 2, name = "x", tabs = { 2 } })
		end
		local cx = Stub.cx(panes, 1, { sessions = sessions, current = 9 })
		local plugin = Stub.load({ env = ENV, cx = cx })
		carly_create(plugin, cx)
		eq(effects(cx), case.effects, "effects")
	end)
end

test(
	"a repository session with a tab gets a new tab named after the branch, and the setup goes into its shell",
	function()
		local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/other" }, { pane = 2, tab = 2, cwd = "/r/app" } }, 1, {
			sessions = { { id = 1, name = "other", tabs = { 1 } }, { id = 2, name = "app", tabs = { 2 } } },
		})
		local plugin = Stub.load({ env = ENV, cx = cx })
		local replies = carly_create(plugin, cx)
		eq(effects(cx), "switch 2; new_tab → tab 3, pane 3; name_tab 3 x", "effects")
		eq(session_of_tab(cx, 3), 2, "session of the new tab")
		eq(find_pane(cx, 3).cwd, worktree("x"), "cwd of the new shell")
		prompt_in(plugin, cx, 3)
		eq(#cx.typed == 1 and cx.typed[1].pane, 3, "typed pane")
		eq(replies[1].setup.typed, true, "setup typed")
	end
)

-- A window with pane 1 of /r/app in tab 1 and the worktree x in parked pane 3 only.
local function parked_window(fail: Stub.Fail?): (Stub.Harness, any)
	local cx = Stub.cx(
		{ { pane = 1, tab = 1, cwd = "/r/app" }, { pane = 3, cwd = worktree("x"), parked = true, at_prompt = true } },
		1,
		{ fail = fail }
	)
	return Stub.load({ env = ENV, cx = cx }), cx
end

test("a parked pane of the worktree moves into a new tab of the repository session", function()
	local plugin, cx = parked_window()
	local replies = carly_create(plugin, cx)
	eq(effects(cx), "unpark 3 → tab 1; move_to_new_tab 3 1 → tab 2; name_tab 2 x", "effects")
	eq(find_pane(cx, 3).tab, 2, "tab of the parked pane")
	eq(replies[1].warnings[1], NO_SHELL, "warning")
	eq(setup_toast_titles(cx), "Setup not run: no new shell in the tab", "setup toasts")
end)

test("a parked pane that does not move parks again, and a new tab gets the setup", function()
	local plugin, cx = parked_window({ move_to_new_tab = true })
	carly_create(plugin, cx)
	eq(
		effects(cx),
		"unpark 3 → tab 1; move_to_new_tab 3 1 failed; park 3; new_tab → tab 2, pane 4; name_tab 2 x",
		"effects"
	)
	eq(find_pane(cx, 3).parked, true, "pane 3 parked")
	prompt_in(plugin, cx, 4)
	eq(#cx.typed == 1 and cx.typed[1].pane, 4, "typed pane")
end)

test("a parked pane that does not unpark leaves the tab to a new shell, which gets the setup", function()
	local plugin, cx = parked_window({ unpark = true })
	carly_create(plugin, cx)
	eq(effects(cx), "unpark 3 failed; new_tab → tab 2, pane 4; name_tab 2 x", "effects")
	prompt_in(plugin, cx, 4)
	eq(#cx.typed == 1 and cx.typed[1].pane, 4, "typed pane")
end)

-- A window with session 1 of /r/other (current) and session 2 of /r/app, whose tab 2 holds pane 2. The worktree x
-- is in parked pane 3 of session 2. The hotkey runs one time while tab 2 is open, then pane 2 parks.
local function tabless_session(): (Stub.Harness, any)
	local panes: { Stub.Pane } = {
		{ pane = 1, tab = 1, cwd = "/r/other" },
		{ pane = 2, tab = 2, cwd = "/r/app" },
		{ pane = 3, cwd = worktree("x"), parked = true, at_prompt = true, session = 2 },
	}
	local cx = Stub.cx(panes, 1, {
		sessions = { { id = 1, name = "other", tabs = { 1 } }, { id = 2, name = "app", tabs = { 2 } } },
	})
	local plugin = Stub.load({ env = ENV, cx = cx })
	press_hotkey(plugin, cx)
	cx.layout:park(2)
	table.clear(cx.effects)
	return plugin, cx
end

test("a repository session with no tab gets a tab, the parked pane goes into it and its shell closes", function()
	local plugin, cx = tabless_session()
	local replies = carly_create(plugin, cx)
	eq(effects(cx), "switch 2; new_tab → tab 3, pane 4; unpark 3 → tab 3; close 4; name_tab 3 x", "effects")
	eq(find_pane(cx, 3).tab, 3, "tab of the parked pane")
	eq(session_of_tab(cx, 3), 2, "session of the tab")
	eq(replies[1].warnings[1], NO_SHELL, "warning")
end)

test("a session with no tab keeps its repository over a second resolve", function()
	local plugin, cx = tabless_session()
	press_hotkey(plugin, cx)
	carly_create(plugin, cx)
	eq(effects(cx), "switch 2; new_tab → tab 3, pane 4; unpark 3 → tab 3; close 4; name_tab 3 x", "effects")
end)

test("a closed session drops its repository, and the worktree gets a new session", function()
	local plugin, cx = tabless_session()
	table.remove(cx.records, 2)
	table.remove(cx.session:panes(), 3)
	table.remove(cx.session:panes(), 2)
	press_hotkey(plugin, cx)
	carly_create(plugin, cx)
	eq(effects(cx), "create_session 2 app → tab 2, pane 2; name_tab 2 x", "effects")
end)

test("a repository with no session gets a session named after it, with the parked pane in its first tab", function()
	local cx = Stub.cx({
		{ pane = 1, tab = 1, cwd = "/r/other" },
		{ pane = 3, cwd = worktree("x"), parked = true, at_prompt = true },
	}, 1)
	local plugin = Stub.load({ env = ENV, cx = cx })
	local replies = carly_create(plugin, cx)
	eq(effects(cx), "create_session 2 app → tab 2, pane 4; unpark 3 → tab 2; close 4; name_tab 2 x", "effects")
	eq(cx.records[2].name, "app", "session name")
	eq(find_pane(cx, 3).tab, 2, "tab of the parked pane")
	eq(replies[1].warnings[1], NO_SHELL, "warning")
end)

test("a repository with no session gets exactly one new session, and its next worktree reuses it", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/other" } }, 1)
	local plugin = Stub.load({ env = ENV, cx = cx })
	carly_create(plugin, cx)
	eq(effects(cx), "create_session 2 app → tab 2, pane 2; name_tab 2 x", "effects after x")
	prompt_in(plugin, cx, 2)
	eq(#cx.typed == 1 and cx.typed[1].pane, 2, "typed pane")
	table.clear(cx.effects)
	carly_create(plugin, cx, "y")
	eq(effects(cx), "new_tab → tab 3, pane 3; name_tab 3 y", "effects after y")
	eq(#cx.records, 2, "sessions")
end)

for _, ids in { { oldest = 1, later = 3 }, { oldest = 2, later = 5 } } do
	test(
		`two sessions of the repository, {ids.oldest} and {ids.later} current: the tab opens in the oldest session`,
		function()
			local oldest, later = ids.oldest, ids.later
			local panes: { Stub.Pane } =
				{ { pane = later, tab = later, cwd = "/r/app" }, { pane = oldest, tab = oldest, cwd = "/r/app" } }
			local cx = Stub.cx(panes, later, {
				sessions = {
					{ id = oldest, name = "app", tabs = { oldest } },
					{ id = later, name = "app 2", tabs = { later } },
				},
				current = later,
			})
			local plugin = Stub.load({ env = ENV, cx = cx })
			carly_create(plugin, cx)
			local fresh = later + 1
			eq(effects(cx), `switch {oldest}; new_tab → tab {fresh}, pane {fresh}; name_tab {fresh} x`, "effects")
			eq(tabs_of(cx, oldest), `{oldest},{fresh}`, "tabs of the oldest session")
			eq(tabs_of(cx, later), `{later}`, "tabs of the current session")
		end
	)
end

-- The session that gets the new tab of a worktree of /r/app, when two or more sessions could get it. /o/app-w is a
-- linked worktree of /r/app outside it, /r/app/.wt/z is a linked worktree of /r/app in it, and /r/app/src is a folder
-- of the main checkout. Session 4 is current.
for _, case in
	{
		{
			what = "a session with the main checkout beats a lower id session whose first pane is a linked worktree",
			panes = { { pane = 1, tab = 1, cwd = "/o/app-w" }, { pane = 2, tab = 2, cwd = "/r/app/src" } },
			sessions = { { id = 4, name = "Default", tabs = { 1 } }, { id = 9, name = "work", tabs = { 2 } } },
			want = 9,
		},
		{
			what = "a session with the main checkout beats a lower id session named after the repository",
			panes = { { pane = 1, tab = 1, cwd = "/o/app-w" }, { pane = 2, tab = 2, cwd = "/r/app" } },
			sessions = { { id = 4, name = "app", tabs = { 1 } }, { id = 9, name = "work", tabs = { 2 } } },
			want = 9,
		},
		{
			what = "a linked worktree in the main checkout folder is not the main checkout",
			panes = { { pane = 1, tab = 1, cwd = "/r/app/.wt/z" }, { pane = 2, tab = 2, cwd = "/r/app" } },
			sessions = { { id = 4, name = "Default", tabs = { 1 } }, { id = 9, name = "work", tabs = { 2 } } },
			want = 9,
		},
		{
			what = "a session named after the repository beats a lower id session without the main checkout",
			panes = { { pane = 1, tab = 1, cwd = "/o/app-w" }, { pane = 2, tab = 2, cwd = worktree("y") } },
			sessions = { { id = 4, name = "Default", tabs = { 1 } }, { id = 9, name = "app", tabs = { 2 } } },
			want = 9,
		},
		{
			what = "a session named after the repository that shows no folder of it beats a session that shows one",
			panes = { { pane = 1, tab = 1, cwd = "/o/app-w" }, { pane = 2, tab = 2, cwd = "/r/other" } },
			sessions = { { id = 4, name = "Default", tabs = { 1 } }, { id = 9, name = "app", tabs = { 2 } } },
			want = 9,
		},
		{
			what = "with no main checkout and no name, the lowest id of the sessions that show the repository wins",
			panes = {
				{ pane = 1, tab = 1, cwd = "/r/other" },
				{ pane = 2, tab = 2, cwd = "/o/app-w" },
				{ pane = 3, tab = 3, cwd = worktree("y") },
			},
			sessions = {
				{ id = 4, name = "Default", tabs = { 1 } },
				{ id = 9, name = "b", tabs = { 3 } },
				{ id = 7, name = "a", tabs = { 2 } },
			},
			want = 7,
		},
		{
			what = "a session whose first pane is in another repository and a later pane in the repository shows it",
			panes = { { pane = 1, tab = 1, cwd = "/r/other" }, { pane = 2, tab = 2, cwd = "/o/app-w" } },
			sessions = { { id = 4, name = "Default", tabs = { 1, 2 } } },
			want = 4,
		},
	}
do
	test(case.what, function()
		local cx = Stub.cx(case.panes, 1, { sessions = case.sessions, current = 4 })
		local index = { ["/r/app/.wt/z"] = { main = "/r/app", branch = "z", changed = 0, owner = "omp" } }
		local plugin = Stub.load({ env = ENV, cx = cx, kv = { worktreeIndex = index } })
		carly_create(plugin, cx)
		local named: number? = nil
		for tab, name in cx.names do
			if name == "x" then
				named = tab
			end
		end
		eq(#cx.records, #case.sessions, "sessions")
		eq(session_of_tab(cx, named), case.want, "session of the new tab")
	end)
end

test("a new session with no tab opens no tab", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/other" } }, 1, { fail = { create = true } })
	local plugin = Stub.load({ env = ENV, cx = cx })
	local replies = carly_create(plugin, cx)
	eq(effects(cx), "create_session 2 app → no tab", "effects")
	eq(replies[1].warnings[1], "setup not run: no tab opened", "warning")
	eq(setup_toast_titles(cx), "Setup not run: no tab opened", "setup toasts")
end)

test("the index entry of the worktree is there when the first effect runs", function()
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = "/r/app" } }, 1)
	local plugin = Stub.load({ env = ENV, cx = cx })
	local seen: any = false
	cx.on_effect = function(_line: string)
		if seen == false then
			local stored = plugin.kv.worktreeIndex
			seen = if stored ~= nil then stored[worktree("x")] else nil
		end
	end
	carly_create(plugin, cx)
	eq(cx.effects[1], "new_tab → tab 2, pane 2", "first effect")
	eq(seen and serde.encode("json", seen), '{"branch":"x","changed":0,"main":"/r/app","owner":"tern"}', "entry")
end)

runner.finish()
