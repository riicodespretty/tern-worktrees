--!strict

-- Gives the worktree variables to a shell that starts in a worktree of the worktree index. The window half writes
-- the index from `tern-wt list --all`. This filter only reads the index from kv.

local INDEX_KEY = "worktreeIndex"

local function with_variables(spec: SpawnSpec): SpawnSpec?
	local index = tern.kv.get(INDEX_KEY)
	if type(index) ~= "table" then
		return nil
	end
	local cwd = spec.cwd
	local home = tern.getenv("HOME")
	if home ~= nil and home ~= "" and (cwd == "~" or string.sub(cwd, 1, 2) == "~/") then
		cwd = home .. string.sub(cwd, 2)
	end
	local worktreePath: string? = nil
	for path in pairs(index) do
		if
			type(path) == "string"
			and (cwd == path or string.sub(cwd, 1, #path + 1) == path .. "/")
			and (worktreePath == nil or #path > #worktreePath)
		then
			worktreePath = path
		end
	end
	if worktreePath == nil then
		return nil
	end
	local entry = index[worktreePath]
	if type(entry.main) ~= "string" then
		return nil
	end
	-- NOTE: Tern gives `spec.args` and `spec.env` as read-only tables, which `table.clone` refuses.
	local env: { [string]: string } = {}
	for name, value in spec.env do
		env[name] = value
	end
	env.TERN_WT_PATH = worktreePath
	env.TERN_WT_MAIN = entry.main
	if type(entry.branch) == "string" then
		env.TERN_WT_BRANCH = entry.branch
	end
	local args: { string } = {}
	for i = 1, #spec.args do
		args[i] = spec.args[i]
	end
	return { program = spec.program, args = args, cwd = spec.cwd, env = env }
end

tern.on("spawn", function(spec: SpawnSpec): SpawnSpec?
	local ok, result = pcall(with_variables, spec)
	return if ok then result else nil
end)
