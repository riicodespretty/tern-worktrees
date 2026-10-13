--!strict

local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

type Case = { what: string, index: { string }, cwd: string?, path: string? }

-- Each case gives the paths of the index, the cwd, and the index path that the lookup must find (nil for none).
local CASES: { Case } = {
	{
		what = "a cwd equal to a worktree path",
		index = { "/r/a/feature" },
		cwd = "/r/a/feature",
		path = "/r/a/feature",
	},
	{
		what = "a cwd nested in a worktree",
		index = { "/r/a/feature" },
		cwd = "/r/a/feature/src/lib",
		path = "/r/a/feature",
	},
	{ what = "a cwd that only starts with the text of a path", index = { "/r/a/feature" }, cwd = "/r/a/feat" },
	{ what = "a path that only starts with the text of the cwd", index = { "/r/a/feat" }, cwd = "/r/a/feature" },
	{
		what = "the longest of two nested worktree paths",
		index = { "/r/b", "/r/b/inner" },
		cwd = "/r/b/inner/src",
		path = "/r/b/inner",
	},
	{
		what = "the outer of two nested worktree paths",
		index = { "/r/b", "/r/b/inner" },
		cwd = "/r/b/src",
		path = "/r/b",
	},
	{ what = "a cwd outside every worktree path", index = { "/r/a/feature" }, cwd = "/tmp" },
	{ what = "a cwd above a worktree path", index = { "/r/a/feature" }, cwd = "/r/a" },
	{ what = "a pane without a cwd", index = { "/r/a/feature" } },
}

-- The worktree index of `paths`, with each path as the branch of its entry.
local function index_of(paths: { string }): { [string]: any }
	local index: { [string]: any } = {}
	for i, path in paths do
		index[path] = { main = "/src/a", branch = path, changed = 0, owner = if i == 1 then "tern" else "omp" }
	end
	return index
end

local function host_lookup(index: { [string]: any }, cwd: string?): string?
	local host = Stub.load({ file = "host.luau", env = Stub.ENV, kv = { worktreeIndex = index } })
	local spawn: any = host.handlers.spawn
	local spec = spawn({ program = "/bin/zsh", args = {}, cwd = cwd, env = {} })
	return if spec ~= nil then spec.env.TERN_WT_PATH else nil
end

local function window_lookup(index: { [string]: any }, cwd: string?): string?
	local window = Stub.load({ env = Stub.ENV, kv = { worktreeIndex = index } })
	local segments = window:status(cwd)
	return if segments ~= nil then segments[1].text else nil
end

for _, case in CASES do
	test(`host and window find {case.path or "no worktree"} for {case.what}`, function()
		eq(host_lookup(index_of(case.index), case.cwd), case.path, "host TERN_WT_PATH")
		eq(window_lookup(index_of(case.index), case.cwd), case.path, "window segment")
	end)
end

runner.finish()
