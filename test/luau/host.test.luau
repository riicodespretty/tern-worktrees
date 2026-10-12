--!strict

local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local INDEX = {
	["/r/a/feature"] = { main = "/src/a", branch = "feature", changed = 0 },
	["/r/7-abc1234"] = { main = "/src/a", changed = 0 },
}

-- Tern 0.8.0 passes `args` as a read-only table that `table.clone` refuses ("table has a protected metatable").
local function read_only(list: { string }): { string }
	return setmetatable({}, {
		__index = list,
		__len = function()
			return #list
		end,
		__metatable = "read-only",
	}) :: any
end

local function spawn_in(cwd: string, kv: { [string]: any }?): any
	local plugin = Stub.load({ file = "host.luau", env = { HOME = "/r" }, kv = kv or { worktreeIndex = INDEX } })
	return plugin.handlers.spawn({
		program = "/bin/zsh",
		args = read_only({ "-l" }),
		cwd = cwd,
		env = { TERN_PANE = "7", TERN_WINDOW_KEY = "w" },
	})
end

local function names(env: { [string]: string }): string
	local list: { string } = {}
	for name in env do
		table.insert(list, name)
	end
	table.sort(list)
	return table.concat(list, ",")
end

test("a shell at a worktree path gets the worktree variables", function()
	local spec = spawn_in("/r/a/feature")
	eq(spec.env.TERN_WT_PATH, "/r/a/feature", "TERN_WT_PATH")
	eq(spec.env.TERN_WT_MAIN, "/src/a", "TERN_WT_MAIN")
	eq(spec.env.TERN_WT_BRANCH, "feature", "TERN_WT_BRANCH")
end)

test("a detached HEAD gives no TERN_WT_BRANCH", function()
	local spec = spawn_in("/r/7-abc1234")
	eq(spec.env.TERN_WT_PATH, "/r/7-abc1234", "TERN_WT_PATH")
	eq(spec.env.TERN_WT_MAIN, "/src/a", "TERN_WT_MAIN")
	eq(spec.env.TERN_WT_BRANCH, nil, "TERN_WT_BRANCH")
end)

test("the program, the arguments, the cwd and the daemon variables are kept", function()
	local spec = spawn_in("/r/a/feature/src")
	eq(spec.program, "/bin/zsh", "program")
	eq(#spec.args, 1, "args")
	eq(spec.args[1], "-l", "args[1]")
	eq(spec.cwd, "/r/a/feature/src", "cwd")
	eq(spec.env.TERN_PANE, "7", "TERN_PANE")
	eq(spec.env.TERN_WINDOW_KEY, "w", "TERN_WINDOW_KEY")
	eq(names(spec.env), "TERN_PANE,TERN_WINDOW_KEY,TERN_WT_BRANCH,TERN_WT_MAIN,TERN_WT_PATH", "env names")
end)

test("no index gives nothing", function()
	eq(spawn_in("/r/a/feature", {}), nil, "spec")
end)

test("a kv read that raises gives nothing", function()
	local raising: { [string]: any } = setmetatable({}, {
		__index = function()
			error("kv.json is not JSON")
		end,
	}) :: any
	eq(spawn_in("/r/a/feature", raising), nil, "spec")
end)

test("an entry without a string main gives nothing", function()
	eq(
		spawn_in("/r/a/feature", { worktreeIndex = { ["/r/a/feature"] = { main = 1, branch = "feature" } } }),
		nil,
		"spec"
	)
end)

test("an entry that is not a table gives nothing", function()
	eq(spawn_in("/r/a/feature", { worktreeIndex = { ["/r/a/feature"] = "feature" } }), nil, "spec")
end)

test("a key that is not a string is skipped and a string key still matches", function()
	local index: { [any]: any } =
		{ [7] = { main = "/src/x" }, ["/r/a/feature"] = { main = "/src/a", branch = "feature" } }
	local spec = spawn_in("/r/a/feature/src", { worktreeIndex = index })
	eq(spec ~= nil and spec.env.TERN_WT_PATH, "/r/a/feature", "TERN_WT_PATH")
end)

test("a leading ~ is expanded with HOME and the cwd is kept as given", function()
	local spec = spawn_in("~/a/feature")
	eq(spec.env.TERN_WT_PATH, "/r/a/feature", "TERN_WT_PATH")
	eq(spec.cwd, "~/a/feature", "cwd")
end)

runner.finish()
