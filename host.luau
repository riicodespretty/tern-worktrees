--!strict

-- Gives a shell that starts in a worktree of the worktree index the worktree variables. The window half writes
-- the index from `tern-wt list --all`; this filter only reads it from kv, because a spawn filter has 50 ms and
-- runs no process.

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
	local key: string? = nil
	for path in pairs(index) do
		if
			type(path) == "string"
			and (cwd == path or string.sub(cwd, 1, #path + 1) == path .. "/")
			and (key == nil or #path > #key)
		then
			key = path
		end
	end
	if key == nil then
		return nil
	end
	local entry = index[key]
	if type(entry.main) ~= "string" then
		return nil
	end
	-- `spec` comes in read-only tables, which `table.clone` refuses, so copy them field by field.
	local env: { [string]: string } = {}
	for name, value in spec.env do
		env[name] = value
	end
	env.TERN_WT_PATH = key
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
