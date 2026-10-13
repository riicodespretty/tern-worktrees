--!strict

local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local REPO = "/r/app"
local LIB = "/r/lib"
-- The `resolve` answer of the CLI for REPO and LIB.
local BOTH_RESOLVED = Stub.answer("resolve", { repo = REPO }, function(res: any)
	local lib = table.clone(res.repos[1])
	lib.dir, lib.root, lib.name = LIB, LIB, "lib"
	table.insert(res.repos, lib)
end)
-- The `branches` answer of the CLI for REPO with a worktree of x and the pull request 7.
local BRANCHES = Stub.fixture("branches", Stub.worktree_vars("x"))
local STALE = Stub.answer("branches-offline", { repo = REPO }, { branches = { "main" }, worktrees = {} })
local LIB_RESOLVED = Stub.fixture("resolve", { repo = LIB })
local LIB_BRANCHES = Stub.answer(
	"branches-offline",
	{ repo = LIB },
	{ name = "lib", branches = { "main" }, worktrees = {} }
)
local OFFLINE = Stub.answer("branches-offline", { repo = REPO }, {
	default = "dev",
	branches = { "main", "x", "y" },
	worktrees = { { branch = "y", path = "/wt/worktrees/app/y", managed = true, owner = "tern", main = false } },
})
local FAILED = '{"error":{"code":"git_failed","message":"fetch failed"}}'
-- The `branches` answer of the CLI when `gh pr list` fails, for REPO with a worktree of x.
local PR_LIST_FAILED = Stub.fixture("branches-pr-list-failed", Stub.worktree_vars("x"))
local CREATED = Stub.fixture("create-created", Stub.worktree_vars("y"))
local REMOVED = Stub.answer("remove-kept-policy", Stub.worktree_vars("x"), { branch = "x" })
local PR_ROW = "app: #7 Fix login"
local X_ROW = "app: x · worktree"
local LOADING = "info Loading branches…"
local LOADED = "info Branches loaded"
local MINUTE = 60000
local BRANCHES_ARGV = Stub.argv("branches", { repo = REPO })
local OFFLINE_ARGV = Stub.argv("branches-offline", { repo = REPO })

-- The toasts of the branch picker so far, the ones with "branch" in the title, each as its level and title, joined
-- by "; ".
local function toast_lines(cx: any): string
	local lines: { string } = {}
	for _, t in cx.toasts do
		if string.find(string.lower(t.title), "branch", 1, true) then
			table.insert(lines, t.level .. " " .. t.title)
		end
	end
	return table.concat(lines, "; ")
end

-- A window with pane 1 in REPO plus `extra`, pane 1 focused, and `git.auto_fetch_minutes` set to `minutes`. Returns
-- the harness, the cx and its panes.
local function window(minutes: number, extra: { Stub.Pane }?): (Stub.Harness, any, { Stub.Pane })
	return Stub.window({
		extra = extra,
		fail = { new_tab = true },
		settings = { ["git.auto_fetch_minutes"] = minutes },
	})
end

-- The worktree rows that the plugin registered, by title.
local function rows(plugin: Stub.Harness): { [string]: any }
	local found: { [string]: any } = {}
	for _, spec in plugin.commands do
		if spec.group == "Worktrees" then
			found[spec.title] = spec
		end
	end
	return found
end

-- The titles of the worktree rows that show in the command palette of `cx`, sorted and joined by "; ".
local function shown(plugin: Stub.Harness, cx: any): string
	local titles: { string } = {}
	for title, spec in rows(plugin) do
		if spec.available(cx) then
			table.insert(titles, title)
		end
	end
	table.sort(titles)
	return table.concat(titles, "; ")
end

-- Whether the worktree row with `title` shows in the command palette of `cx`.
local function shows(plugin: Stub.Harness, cx: any, title: string): boolean
	local spec = rows(plugin)[title]
	return spec ~= nil and spec.available(cx)
end

-- A `cwd` event of pane 1 into REPO, which is a background trigger of the worktree rows. The first one resolves REPO.
local function trigger(plugin: Stub.Harness, cx: any)
	plugin.handlers.cwd({ pane = 1, path = REPO }, cx)
	plugin:answer("resolve", Stub.RESOLVED, 0, cx)
end

test("a create runs one branches for its repository", function()
	local plugin, cx = window(0)
	plugin:pick_branch(cx, "b:x", BRANCHES)
	plugin:answer_create(cx, CREATED)
	eq(plugin:pending_line("branches"), OFFLINE_ARGV, "branches calls after the create")
end)

test("a teardown runs branches only for the repository in the repo of remove", function()
	local plugin, cx = window(0, { { pane = 2, tab = 2, cwd = LIB } })
	plugin.handlers.window_start(cx)
	plugin:answer("resolve", BOTH_RESOLVED, 0, cx)
	eq(plugin:pending_line("branches"), OFFLINE_ARGV .. "; " .. Stub.argv("branches-offline", { repo = LIB }), "rows")
	plugin:answer("branches", STALE, 0, cx)
	local call = Stub.call()
	plugin.exports.remove("/wt/worktrees/app/x", nil, cx, call)
	plugin:answer("remove", REMOVED, 0, cx)
	eq(plugin:pending_line("branches"), OFFLINE_ARGV, "branches calls after the teardown")
end)

test("the first open of the branch picker registers the worktree rows of its answer", function()
	local plugin, cx, panes = window(0, { { pane = 2, tab = 2, cwd = "/tmp" } })
	plugin:press(cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	plugin.handlers.cwd({ pane = 2, path = "/tmp" }, cx)
	trigger(plugin, cx)
	eq(shown(plugin, cx), "app: #7 Fix login; app: main; app: x · worktree", "rows for a pane in /r/app")
	eq(shown(plugin, Stub.cx(panes, 2)), "", "rows for a pane in /tmp")
end)

test("the worktree rows keep their pull requests after an offline answer and after prsFailed true", function()
	local plugin, cx = window(0)
	plugin:press(cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	trigger(plugin, cx)
	eq(plugin:pending_line("branches"), OFFLINE_ARGV, "background branches")
	plugin:answer("branches", OFFLINE, 0, cx)
	eq(shows(plugin, cx, PR_ROW), true, "pull request row after the offline answer")
	plugin:press(cx)
	eq(plugin:pending_line("branches"), BRANCHES_ARGV, "branches of the press")
	plugin:answer("branches", PR_LIST_FAILED, 0, cx)
	eq(shows(plugin, cx, PR_ROW), true, "pull request row after prsFailed true")
end)

test("the row of a branch that leaves the answer does not show", function()
	local plugin, cx = window(0)
	trigger(plugin, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	eq(shows(plugin, cx, X_ROW), true, "row of x before")
	trigger(plugin, cx)
	plugin:answer("branches", STALE, 0, cx)
	eq(shows(plugin, cx, X_ROW), false, "row of x after x left the answer")
	eq(shows(plugin, cx, "app: main"), true, "row of main after x left the answer")
end)

test("an answer for one repository keeps the worktree rows of another repository", function()
	local plugin, cx, panes = window(0, { { pane = 2, tab = 2, cwd = LIB } })
	local libCx = Stub.cx(panes, 2)
	trigger(plugin, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	plugin.handlers.cwd({ pane = 2, path = LIB }, libCx)
	plugin:answer("resolve", LIB_RESOLVED, 0, libCx)
	plugin:answer("branches", LIB_BRANCHES, 0, libCx)
	eq(shown(plugin, cx), "app: #7 Fix login; app: main; app: x · worktree", "rows of app after the lib answer")
	eq(shown(plugin, libCx), "lib: main", "rows of lib")
	plugin.handlers.cwd({ pane = 1, path = REPO }, cx)
	plugin:answer("branches", STALE, 0, cx)
	eq(shown(plugin, cx), "app: #7 Fix login; app: main", "rows of app after its offline answer")
	eq(shown(plugin, libCx), "lib: main", "rows of lib after the app answer")
end)

test("the row of a branch with a worktree sends create with --branch=<name>", function()
	local plugin, cx = window(0)
	trigger(plugin, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	rows(plugin)[X_ROW].run(cx)
	eq(plugin:pending_line("create"), Stub.argv("create-branch", { repo = REPO, branch = "x" }), "create argv")
end)

test("the branch picker and the row of a branch that starts with - send the same create", function()
	local dashBranchAnswer = Stub.answer("branches-offline", { repo = REPO }, { branches = { "-x" }, worktrees = {} })
	local plugin, cx = window(0)
	plugin:pick_branch(cx, "b:-x", dashBranchAnswer)
	rows(plugin)["app: -x"].run(cx)
	local argv = Stub.argv("create-branch", { repo = REPO, branch = "-x" })
	eq(plugin:pending_line("create"), argv .. "; " .. argv, "create argv of the pick, then of the row")
end)

test("the row of a pull request sends create with --pr and toasts its head branch", function()
	local plugin, cx = window(0)
	trigger(plugin, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	rows(plugin)[PR_ROW].run(cx)
	eq(plugin:pending_line("create"), Stub.argv("create-pr", { repo = REPO, pr = "7" }), "create argv")
	eq(cx.toasts[#cx.toasts].title, "Creating worktree fix-login…", "toast title")
end)

test("a background trigger runs online when git.auto_fetch_minutes is due, and a press counts as online", function()
	local plugin, cx = window(5)
	trigger(plugin, cx)
	eq(plugin:pending_line("branches"), BRANCHES_ARGV, "first trigger")
	plugin:answer("branches", BRANCHES, 0, cx)
	plugin:tick(MINUTE)
	trigger(plugin, cx)
	eq(plugin:pending_line("branches"), OFFLINE_ARGV, "trigger after 1 min")
	plugin:answer("branches", BRANCHES, 0, cx)
	plugin:tick(4 * MINUTE)
	trigger(plugin, cx)
	eq(plugin:pending_line("branches"), BRANCHES_ARGV, "trigger after 5 min")
	plugin:answer("branches", BRANCHES, 0, cx)
	plugin:tick(5 * MINUTE)
	plugin:press(cx)
	eq(plugin:pending_line("branches"), BRANCHES_ARGV, "press after 10 min")
	plugin:answer("branches", BRANCHES, 0, cx)
	plugin:tick(MINUTE)
	trigger(plugin, cx)
	eq(plugin:pending_line("branches"), OFFLINE_ARGV, "trigger 1 min after the press")
end)

test("with git.auto_fetch_minutes 0 a background trigger never runs online", function()
	local plugin, cx = window(0)
	trigger(plugin, cx)
	eq(plugin:pending_line("branches"), OFFLINE_ARGV, "first trigger")
	plugin:answer("branches", BRANCHES, 0, cx)
	plugin:tick(60 * MINUTE)
	trigger(plugin, cx)
	eq(plugin:pending_line("branches"), OFFLINE_ARGV, "trigger after 60 min")
end)

test("a press during a background branches starts no second one and runs one online with toasts after it", function()
	local plugin, cx = window(0)
	trigger(plugin, cx)
	plugin:press(cx)
	eq(plugin:pending_line("branches"), OFFLINE_ARGV, "branches calls after the press")
	eq(toast_lines(cx), "", "toasts after the press")
	plugin:answer("branches", OFFLINE, 0, cx)
	eq(plugin:pending_line("branches"), BRANCHES_ARGV, "run after the background branches")
	eq(toast_lines(cx), LOADING, "toasts after the online run starts")
	plugin:answer("branches", BRANCHES, 0, cx)
	eq(#cx.asked, 1, "pickers after the online answer")
	eq(toast_lines(cx), LOADING .. "; " .. LOADED, "toasts after the online answer")
end)

test("a first press joins a background online branches", function()
	local plugin, cx = window(5)
	trigger(plugin, cx)
	plugin:press(cx)
	eq(plugin:pending_line("branches"), BRANCHES_ARGV, "branches calls after the press")
	eq(toast_lines(cx), LOADING, "toasts after the press")
	plugin:answer("branches", BRANCHES, 0, cx)
	eq(#cx.asked, 1, "pickers after the answer")
	eq(toast_lines(cx), LOADING .. "; " .. LOADED, "toasts after the answer")
	eq(plugin:pending_line("branches"), "", "branches calls after the answer")
end)

test("a first press with only an offline answer waits for the online answer", function()
	local plugin, cx = window(0)
	trigger(plugin, cx)
	plugin:answer("branches", OFFLINE, 0, cx)
	trigger(plugin, cx)
	plugin:press(cx)
	plugin:answer("branches", OFFLINE, 0, cx)
	eq(#cx.asked, 0, "pickers after the offline answer")
	eq(plugin:pending_line("branches"), BRANCHES_ARGV, "run after the offline answer")
	eq(toast_lines(cx), LOADING, "toasts after the online run starts")
	plugin:answer("branches", BRANCHES, 0, cx)
	eq(#cx.asked, 1, "pickers after the online answer")
	Stub.item(cx.asked[1], "pr:7")
end)

test("a trigger after a branches whose callback Tern dropped for 120 s starts a new one", function()
	local plugin, cx = window(0)
	trigger(plugin, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	trigger(plugin, cx)
	local dropped = plugin:take("branches")[1]
	dropped:respond(BRANCHES, 0, nil)
	plugin:tick(120000)
	trigger(plugin, cx)
	eq(plugin:pending_line("branches"), "", "branches calls at 120 s")
	plugin:tick(1)
	trigger(plugin, cx)
	eq(plugin:pending_line("branches"), OFFLINE_ARGV, "branches calls after 120 s")
	plugin:answer("branches", STALE, 0, cx)
	dropped:respond(BRANCHES, 0, cx)
	eq(shows(plugin, cx, X_ROW), false, "row of x after the late answer")
	eq(plugin:pending_line("branches"), "", "branches calls after the late answer")
end)

test("a failed first online branches after an offline answer toasts the cause and keeps the rows", function()
	local plugin, cx = window(0)
	trigger(plugin, cx)
	plugin:answer("branches", OFFLINE, 0, cx)
	local before = shown(plugin, cx)
	plugin:press(cx)
	plugin:answer("branches", FAILED, 1, cx)
	eq(#cx.asked, 0, "pickers after the failure")
	eq(cx.toasts[#cx.toasts].title, "fetch failed", "toast title")
	eq(shown(plugin, cx), before, "rows after the failure")
	plugin:press(cx)
	eq(#cx.asked, 0, "pickers on the next press, which waits again")
	eq(plugin:pending_line("branches"), BRANCHES_ARGV, "branches calls of the next press")
end)

runner.finish()
