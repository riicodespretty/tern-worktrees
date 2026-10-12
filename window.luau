--!strict

local CLI = tern.plugin.dir .. "/bin/tern-wt"
local NO_BREAK_SPACE = "\u{A0}"

local function env(name: string): string?
	local value = tern.getenv(name)
	return if value == "" then nil else value
end

local ROOT_KEY = "worktreeRoot"

local function without_trailing_slash(dir: string): string
	return (string.gsub(dir, "/+$", ""))
end

local function initial_root(): string
	local home = env("TERN_WT_HOME")
	if home ~= nil then
		return without_trailing_slash(home) .. "/worktrees"
	end
	local ok, remembered = pcall(tern.kv.get, ROOT_KEY)
	if ok and type(remembered) == "string" and remembered ~= "" then
		return without_trailing_slash(remembered)
	end
	return (env("HOME") or "") .. "/.tern-wt/worktrees"
end

local ROOT = initial_root()
local DEFAULT_KEYS = { "cmd+shift+w" }
local DEFAULT_TEARDOWN = "worktree+merged-branch"
local POLICY = {
	worktree = "Tear down removes the worktree and keeps the branch.",
	["worktree+merged-branch"] = "Tear down removes the worktree, and deletes the branch if it is merged.",
	["worktree+branch"] = "Tear down removes the worktree and deletes the branch.",
}

type CliCb<T> = (result: T, err: any, cx: WindowCx) -> ()
type PullRequest = { number: number, title: string, branch: string }
type BranchWorktree = { branch: string?, path: string }
type BranchesResult = {
	name: string,
	default: string,
	branches: { string },
	prs: { PullRequest },
	worktrees: { BranchWorktree },
	warnings: { string },
}
type CreateResult = {
	branch: string,
	carried: { string },
	path: string,
	repo: string,
	status: string,
	warnings: { string },
}
type GithubRepo = { nameWithOwner: string, description: string? }
type ReposResult = { owners: { string }, repos: { GithubRepo } }
type ResolvedDir = { dir: string, root: string?, name: string? }
type ResolveResult = { repos: { ResolvedDir } }
type RemoveResult = { removed: string, branch: string?, warnings: { string } }
type ListResult = { root: string, worktrees: { any } }
type RootResult = { root: string }
type IndexEntry = { main: string, branch: string?, changed: number }
type RootState = {
	rows: { string }?,
	prs: { PullRequest }?,
	networkAt: number?,
	refreshing: boolean,
	again: boolean,
}
type SessionIndex = {
	byId: { [number]: SessionInfo },
	byTab: { [number]: SessionInfo },
	current: SessionInfo?,
}
type Config = { hotkeys: { new: { string } }, teardown: string }
type Repo = { root: string, name: string }

local startCount = 0
local managed: { [number]: { string } } = {}
local handled: { [string]: boolean } = {}
local rootOfSession: { [number]: string } = {}
local localRepos: { Repo } = {}
local queuedErrors: { string } = {}
local configWarned = false
local rootOfDir: { [string]: string | false } = {}
local cwdOfPane: { [number]: string? } = {}
local resolving: { [string]: boolean } = {}
local rootOfLiveRow: { [string]: string } = {}
local stateOfRoot: { [string]: RootState } = {}
local refresh: (cx: WindowCx, root: string) -> ()

local function state_of(root: string): RootState
	local existing = stateOfRoot[root]
	if existing ~= nil then
		return existing
	end
	local created: RootState = { refreshing = false, again = false }
	stateOfRoot[root] = created
	return created
end

local function refresh_all_roots(cx: WindowCx)
	for root, state in pairs(stateOfRoot) do
		if state.rows ~= nil then
			refresh(cx, root)
		end
	end
end

local function after_change(cx: WindowCx, root: string?)
	if root == nil then
		refresh_all_roots(cx)
	else
		refresh(cx, root)
	end
end

local function flush(cx: WindowCx)
	for _, text in ipairs(queuedErrors) do
		cx:toast("error", text)
	end
	table.clear(queuedErrors)
end

local function cli<T>(args: { string }, cb: CliCb<T>)
	tern.process.run({ CLI, table.unpack(args) }, { timeout_ms = 120000 }, function(r: ProcessResult, cx: WindowCx?)
		if cx == nil then
			return
		end
		local ok, decoded = pcall(tern.json.decode, r.stdout)
		if not ok or type(decoded) ~= "table" then
			cb(nil :: any, { code = "cli_failed", message = if r.stderr ~= "" then r.stderr else "tern-wt failed" }, cx)
		elseif r.status ~= 0 then
			cb(nil :: any, decoded.error or { code = "cli_failed", message = r.stderr }, cx)
		else
			cb(decoded :: any, nil, cx)
		end
	end)
end

local function is_under(cwd: string?, path: string): boolean
	return cwd ~= nil and (cwd == path or string.sub(cwd, 1, #path + 1) == path .. "/")
end

local INDEX_KEY = "worktreeIndex"
local INDEX_GAP_MS = 2000

-- The index stored in kv, or `fallback` when kv holds none or its read raises.
local function stored_index(fallback: { [string]: IndexEntry? }): { [string]: IndexEntry? }
	local ok, stored = pcall(tern.kv.get, INDEX_KEY)
	return if ok and type(stored) == "table" then stored else fallback
end

-- The worktree index: each worktree in the worktree root by path, with its main checkout, branch and number of
-- changed files. The host half reads it from kv to give the worktree variables to a new shell.
local index = stored_index({})
-- When this window last set or deleted each entry; a `list --all` that started before keeps that change.
local recent: { [string]: number } = {}
local listing = false
local listAgain = false
local listTimer = false
local listedAt: number? = nil

local function in_index(cwd: string?): boolean
	for path in pairs(index) do
		if is_under(cwd, path) then
			return true
		end
	end
	return false
end

-- Sets or deletes one entry. Other windows write the same kv key, so this reads kv again and changes only `path`.
local function set_entry(path: string, entry: IndexEntry?)
	local merged = table.clone(stored_index(index))
	merged[path] = entry
	index = merged
	recent[path] = tern.now()
	pcall(tern.kv.set, INDEX_KEY, index)
end

local function apply_list(res: ListResult, startedAt: number)
	local fresh: { [string]: IndexEntry? } = {}
	for _, w in ipairs(res.worktrees or {}) do
		if type(w.path) == "string" and type(w.repo) == "string" then
			fresh[w.path] = {
				main = w.repo,
				branch = if type(w.branch) == "string" then w.branch else nil,
				changed = if type(w.changed) == "number" then w.changed else 0,
			}
		end
	end
	for path, at in pairs(recent) do
		if at >= startedAt then
			fresh[path] = index[path]
		else
			recent[path] = nil
		end
	end
	index = fresh
	pcall(tern.kv.set, INDEX_KEY, index)
end

local refresh_index: () -> ()

-- Runs `list --all`, writes the worktree index from its answer, and passes the answer, or nil on an error, to `cb`.
local function list_all(cb: (res: ListResult?, cx: WindowCx) -> ())
	listing = true
	local startedAt = tern.now()
	listedAt = startedAt
	cli({ "list", "--all" }, function(res: ListResult, err, cx2)
		listing = false
		if err == nil then
			apply_list(res, startedAt)
		end
		cb(if err == nil then res else nil, cx2)
		if listAgain then
			listAgain = false
			refresh_index()
		end
	end)
end

-- Refreshes the worktree index: at most one `list --all` at a time, and at most one each INDEX_GAP_MS. A refresh
-- asked for inside that gap runs once at its end.
refresh_index = function()
	if listing then
		listAgain = true
		return
	end
	if listTimer then
		return
	end
	local wait = if listedAt == nil then 0 else listedAt + INDEX_GAP_MS - tern.now()
	if wait > 0 then
		listTimer = true
		tern.timer(wait, function()
			listTimer = false
			refresh_index()
		end)
		return
	end
	list_all(function() end)
end

local function basename(path: string): string
	return string.match(path, "([^/]+)/*$") or path
end

local function managed_path(cwd: string?): string?
	if cwd == nil or string.sub(cwd, 1, #ROOT + 1) ~= ROOT .. "/" then
		return nil
	end
	local repo, slug = string.match(string.sub(cwd, #ROOT + 2), "^([^/]+)/([^/]+)")
	if repo == nil or slug == nil then
		return nil
	end
	local path = ROOT .. "/" .. repo .. "/" .. slug
	local ok, gitFile = pcall(tern.fs.read, path .. "/.git", 4096)
	if not ok then
		return nil
	end
	local mainCheckout = string.match(gitFile, "^gitdir:%s*(.-)/%.git/worktrees/")
	if mainCheckout == nil or basename(mainCheckout) ~= repo then
		return nil
	end
	return path
end

local function warn_config()
	if not configWarned then
		configWarned = true
		table.insert(queuedErrors, "tern-worktrees: invalid config.json, using defaults")
	end
end

local function config(): Config
	local defaults: Config = { hotkeys = { new = DEFAULT_KEYS }, teardown = DEFAULT_TEARDOWN }
	local path = tern.plugin.data .. "/config.json"
	if not tern.fs.exists(path) then
		return defaults
	end
	local ok, decoded = pcall(function()
		return tern.json.decode(tern.fs.read(path))
	end)
	if not ok or type(decoded) ~= "table" then
		warn_config()
		return defaults
	end
	local hotkeys = decoded.hotkeys
	if hotkeys ~= nil and type(hotkeys) ~= "table" then
		warn_config()
	end
	local keys: any = if type(hotkeys) == "table" then hotkeys.new else nil
	local newKeys = DEFAULT_KEYS
	if keys ~= nil then
		local valid: { string } = {}
		local dropped = type(keys) ~= "table"
		if not dropped then
			local entries = 0
			for _ in pairs(keys) do
				entries += 1
			end
			for _, key in ipairs(keys) do
				if type(key) == "string" then
					table.insert(valid, key)
				else
					dropped = true
				end
			end
			dropped = dropped or entries ~= #keys
		end
		if dropped then
			warn_config()
		end
		if not dropped or #valid > 0 then
			newKeys = valid
		end
	end
	return {
		hotkeys = { new = newKeys },
		teardown = if type(decoded.teardown) == "string" then decoded.teardown else DEFAULT_TEARDOWN,
	}
end

local function join_or_nil(list: any, sep: string): string?
	if type(list) ~= "table" or #list == 0 then
		return nil
	end
	return table.concat(list, sep)
end

local function session_index(cx: WindowCx): SessionIndex
	local index: SessionIndex = { byId = {}, byTab = {}, current = nil }
	for _, s in ipairs(cx.session:sessions()) do
		index.byId[s.id] = s
		for _, tab in ipairs(s.tabs) do
			if index.byTab[tab] == nil then
				index.byTab[tab] = s
			end
		end
		if s.current and index.current == nil then
			index.current = s
		end
	end
	return index
end

local function session_of_tab(index: SessionIndex, tab: number?): number?
	if tab == nil then
		return nil
	end
	local session = index.byTab[tab]
	return if session ~= nil then session.id else nil
end

local function switch_to_session_if_current_known(cx: WindowCx, index: SessionIndex, sid: number)
	local current = index.current
	if current ~= nil and current.id ~= sid then
		cx.sessions:switch(sid)
	end
end

local function switch_to_session(cx: WindowCx, index: SessionIndex, sid: number)
	local current = index.current
	if current == nil or current.id ~= sid then
		cx.sessions:switch(sid)
	end
end

local function tab_paths(cx: WindowCx, tab: number): { string }
	local paths: { string } = {}
	for _, pane in ipairs(cx.session:panes()) do
		if pane.tab == tab then
			local path = managed_path(pane.cwd)
			if path ~= nil and table.find(paths, path) == nil then
				table.insert(paths, path)
			end
		end
	end
	return paths
end

local function close_tab(cx: WindowCx, tab: number)
	local target: number? = nil
	for _, pane in ipairs(cx.session:panes()) do
		if pane.tab == tab then
			target = pane.pane
			break
		end
	end
	if target == nil then
		return
	end
	local index = session_index(cx)
	local sid = session_of_tab(index, tab)
	if sid ~= nil then
		switch_to_session_if_current_known(cx, index, sid)
	end
	cx.layout:focus(target)
	local focused = cx.session:focused()
	if focused == nil or cx.session:tab_of(focused) ~= tab then
		cx:toast("error", "Could not focus the worktree tab", "Close it by hand")
		return
	end
	cx:command("close_tab")
end

local function pane_under(cx: WindowCx, path: string, exceptTab: number?): boolean
	for _, pane in ipairs(cx.session:panes()) do
		if (exceptTab == nil or pane.tab ~= exceptTab) and is_under(pane.cwd, path) then
			return true
		end
	end
	return false
end

local function rebuild_managed(cx: WindowCx)
	flush(cx)
	local found: { [number]: { string } } = {}
	for _, pane in ipairs(cx.session:panes()) do
		local tab = pane.tab
		if tab ~= nil then
			local paths = found[tab] or {}
			found[tab] = paths
			local path = managed_path(pane.cwd)
			if path ~= nil and table.find(paths, path) == nil then
				table.insert(paths, path)
			end
		end
	end
	for tab, paths in pairs(found) do
		if #paths > 0 then
			managed[tab] = paths
		else
			managed[tab] = nil
		end
	end
end

local MAX_PATH = 72

local function short_path(path: string): string
	local home = env("HOME")
	local short = path
	if home ~= nil and string.sub(path, 1, #home + 1) == home .. "/" then
		short = "~" .. string.sub(path, #home + 1)
	elseif string.sub(path, 1, #ROOT + 1) == ROOT .. "/" then
		short = "…/worktrees" .. string.sub(path, #ROOT + 1)
	end
	local length = utf8.len(short) or #short
	if length <= MAX_PATH then
		return short
	end
	local keptChars = MAX_PATH - 1
	local headChars = math.floor(keptChars / 3)
	local tailStartByte = utf8.offset(short, length - (keptChars - headChars) + 1)
		or (#short - (keptChars - headChars) + 1)
	local headEndByte = (utf8.offset(short, headChars + 1) or (headChars + 1)) - 1
	return string.sub(short, 1, headEndByte) .. "…" .. string.sub(short, tailStartByte)
end

-- Every `:next` of `cx:pick` and `cx:prompt` returns at once when its `cx` is nil, and toasts `err`.
local function choose(cx: WindowCx, opts: PickOptions, cb: (item: PickItem?, cx: WindowCx, err: string?) -> ())
	cx:pick(opts):next(function(item: PickItem?, err: string?, cx2: WindowCx?)
		if cx2 == nil then
			return
		end
		if err ~= nil then
			cx2:toast("error", "Picker failed", err)
		end
		cb(item, cx2, err)
	end)
end

local function ask_text(cx: WindowCx, opts: PromptOptions, cb: (text: string?, cx: WindowCx, err: string?) -> ())
	cx:prompt(opts):next(function(text: string?, err: string?, cx2: WindowCx?)
		if cx2 == nil then
			return
		end
		if err ~= nil then
			cx2:toast("error", "Prompt failed", err)
		end
		cb(text, cx2, err)
	end)
end

local MAX_LISTED_FILES = 10

local function staging_line(err: any): string?
	if err ~= nil and type(err.staging) == "string" then
		return "Saved files: " .. err.staging
	end
	return nil
end

local function toast_error(cx: WindowCx, err: any)
	cx:toast("error", tostring(err and err.message or "tern-wt failed"), staging_line(err))
end

local function cli_or_else<T>(args: { string }, on_error: (cx: WindowCx, err: any) -> (), cb: (res: T, cx: WindowCx) -> ())
	cli(args, function(res: T, err: any, cx: WindowCx)
		if err ~= nil then
			on_error(cx, err)
			return
		end
		cb(res, cx)
	end)
end

local function cli_or_toast<T>(args: { string }, cb: (res: T, cx: WindowCx) -> ())
	cli_or_else(args, toast_error, cb)
end

local function replace_plain(text: string, old: string, new: string): string
	if old == "" then
		return text
	end
	local parts: { string } = {}
	local start = 1
	while true do
		local from, to = string.find(text, old, start, true)
		if from == nil or to == nil then
			break
		end
		table.insert(parts, string.sub(text, start, from - 1))
		table.insert(parts, new)
		start = to + 1
	end
	table.insert(parts, string.sub(text, start))
	return table.concat(parts)
end

type DirtyListing = { changes: { string }, ignored: { string }, omitted: number }

local function list_dirty_files(files: any): DirtyListing
	local shown: DirtyListing = { changes = {}, ignored = {}, omitted = 0 }
	if type(files) ~= "table" then
		return shown
	end
	local changes: { string } = {}
	local ignored: { string } = {}
	for i = 1, #files do
		local entry = tostring(files[i])
		if string.sub(entry, 1, 3) == "!! " then
			table.insert(ignored, string.sub(entry, 4))
		else
			table.insert(changes, entry)
		end
	end
	local ignoredShown = math.min(#ignored, MAX_LISTED_FILES)
	local changesShown = math.min(#changes, MAX_LISTED_FILES - ignoredShown)
	table.move(changes, 1, changesShown, 1, shown.changes)
	table.move(ignored, 1, ignoredShown, 1, shown.ignored)
	shown.omitted = #changes + #ignored - changesShown - ignoredShown
	return shown
end

local function dirty_summary(shown: DirtyListing): string
	local parts: { string } = {}
	if #shown.changes > 0 then
		table.insert(parts, table.concat(shown.changes, ", "))
	end
	if #shown.ignored > 0 then
		table.insert(parts, "ignored, hard to rebuild: " .. table.concat(shown.ignored, ", "))
	end
	if shown.omitted > 0 then
		table.insert(parts, "and " .. shown.omitted .. " more")
	end
	local total = #shown.changes + #shown.ignored + shown.omitted
	if total == 0 then
		return ""
	end
	local noun = if total == 1 then " file" else " files"
	return total .. noun .. " with work to lose: " .. table.concat(parts, "; ")
end

local function failure_message(err: any, path: string): string
	local summary = if err.code == "dirty_worktree" then dirty_summary(list_dirty_files(err.files)) else ""
	local parts: { string } = {
		if summary ~= "" then summary else replace_plain(tostring(err.message), path, short_path(path)),
	}
	local saved = staging_line(err)
	if saved ~= nil then
		table.insert(parts, replace_plain(saved, path, short_path(path)))
	end
	return table.concat(parts, " · ")
end

local function fnv1a(text: string): string
	local h = 2166136261
	for i = 1, #text do
		h = bit32.bxor(h, string.byte(text, i))
		h = (h * 403 + bit32.lshift(h, 24)) % 4294967296
	end
	return string.format("%08x", h)
end

local function learn_roots(res: ResolveResult)
	for _, r in ipairs(res.repos or {}) do
		if type(r.dir) == "string" then
			if type(r.root) == "string" then
				rootOfDir[r.dir] = r.root
			else
				rootOfDir[r.dir] = false
			end
		end
	end
end

local function known_cwd(cwd: string?): string?
	if cwd == nil or cwd == "" then
		return nil
	end
	return cwd
end

local function resolve_sessions(cx: WindowCx, cb: (cx: WindowCx) -> ())
	local cwds: { string } = {}
	local seen: { [string]: boolean } = {}
	for _, pane in ipairs(cx.session:panes()) do
		local cwd = known_cwd(pane.cwd)
		if cwd ~= nil and not seen[cwd] then
			seen[cwd] = true
			table.insert(cwds, cwd)
		end
	end
	if #cwds == 0 then
		table.clear(rootOfSession)
		table.clear(localRepos)
		cb(cx)
		return
	end
	table.insert(cwds, 1, "resolve")
	cli_or_else(cwds, function(cx2, err)
		toast_error(cx2, err)
		cb(cx2)
	end, function(res: ResolveResult, cx2)
		learn_roots(res)
		table.clear(localRepos)
		local listedRoots: { [string]: boolean } = {}
		for _, r in ipairs(res.repos or {}) do
			local repoRoot = r.root
			if type(repoRoot) == "string" and not listedRoots[repoRoot] then
				listedRoots[repoRoot] = true
				table.insert(localRepos, { root = repoRoot, name = r.name or basename(repoRoot) })
			end
		end
		local index = session_index(cx2)
		local tabless: { [number]: string } = {}
		for id, root in pairs(rootOfSession) do
			local entry = index.byId[id]
			if entry ~= nil and #entry.tabs == 0 then
				tabless[id] = root
			end
		end
		table.clear(rootOfSession)
		for _, pane in ipairs(cx2.session:panes()) do
			local sid = session_of_tab(index, pane.tab)
			local root = pane.cwd and rootOfDir[pane.cwd]
			if sid ~= nil and type(root) == "string" and rootOfSession[sid] == nil then
				rootOfSession[sid] = root
			end
		end
		for id, root in pairs(tabless) do
			rootOfSession[id] = root
		end
		cb(cx2)
	end)
end

local function open_tab(cx: WindowCx, res: CreateResult)
	local path = res.path
	set_entry(path, { main = res.repo, branch = res.branch, changed = 0 })
	local tab: number? = nil
	local index = session_index(cx)
	local parked: number? = nil
	for _, pane in ipairs(cx.session:panes()) do
		if is_under(pane.cwd, path) then
			if pane.parked then
				parked = parked or pane.pane
			else
				local sid = session_of_tab(index, pane.tab)
				if sid ~= nil then
					switch_to_session_if_current_known(cx, index, sid)
				end
				cx.layout:focus(pane.pane)
				tab = pane.tab
				break
			end
		end
	end
	local sid: number? = nil
	for id, root in pairs(rootOfSession) do
		if root == res.repo and index.byId[id] ~= nil then
			sid = id
			break
		end
	end
	local reused = tab
	local freshTab: number? = nil
	if tab == nil and sid == nil then
		local newSession = cx.sessions:create({ name = basename(res.repo), cwd = path })
		sid = newSession.id
		rootOfSession[newSession.id] = res.repo
		local created = session_index(cx).byId[newSession.id]
		freshTab = if created ~= nil then created.tabs[1] else nil
	end
	if tab == nil and sid ~= nil and freshTab == nil then
		local target = index.byId[sid]
		if target ~= nil and #target.tabs == 0 then
			switch_to_session(cx, index, sid)
			local pane = cx.layout:new_tab({ cwd = path })
			freshTab = if pane ~= nil then cx.session:tab_of(pane) else nil
		end
	end
	if tab == nil and parked ~= nil then
		if freshTab == nil and sid ~= nil then
			switch_to_session(cx, index, sid)
		end
		local shells: { number } = {}
		for _, pane in ipairs(cx.session:panes()) do
			if freshTab ~= nil and pane.tab == freshTab then
				table.insert(shells, pane.pane)
			end
		end
		if cx.layout:unpark(parked) then
			if freshTab ~= nil then
				for _, shell in ipairs(shells) do
					cx.layout:close(shell)
				end
				tab = cx.session:tab_of(parked)
			else
				tab = cx.layout:move_to_new_tab(parked, sid)
				if tab == nil then
					cx.layout:park(parked)
				end
			end
		end
	end
	if tab == nil then
		if freshTab ~= nil then
			tab = freshTab
		elseif sid ~= nil then
			switch_to_session(cx, index, sid)
			local pane = cx.layout:new_tab({ cwd = path })
			tab = if pane ~= nil then cx.session:tab_of(pane) else nil
		end
	end
	if tab ~= nil and tab ~= reused then
		cx.layout:name_tab(tab, res.branch)
	end
	if tab ~= nil and managed_path(path) == path then
		local paths = managed[tab] or {}
		managed[tab] = paths
		if table.find(paths, path) == nil then
			table.insert(paths, path)
		end
	end
end

local function create(cx: WindowCx, root: string, extra: { string }, retry: ((cx: WindowCx) -> ())?)
	local args = { "create", "--repo", root, "--no-tab" }
	for _, a in ipairs(extra) do
		table.insert(args, a)
	end
	cli(args, function(res: CreateResult, err, cx2)
		if err ~= nil then
			if err.code == "bad_args" and retry ~= nil then
				cx2:toast("error", tostring(err.message))
				retry(cx2)
			elseif err.code == "worktree_exists_elsewhere" then
				local existing = tostring(err.existing)
				choose(cx2, {
					placeholder = "Worktree of this branch is at " .. short_path(existing),
					items = {
						{
							id = "relocate",
							label = "Relocate to " .. short_path(tostring(err.target)),
							icon = "folder",
						},
					},
				}, function(item, cx3, pickErr)
					if pickErr == nil and item ~= nil and item.id == "relocate" then
						local again = table.clone(extra)
						table.insert(again, "--relocate")
						create(cx3, root, again)
					end
				end)
			elseif err.code == "dirty_worktree" then
				cx2:toast("error", "Cannot relocate: uncommitted changes", dirty_summary(list_dirty_files(err.files)))
			elseif err.code == "branch_in_main_checkout" then
				cx2:toast("error", "Branch is checked out in the main checkout", err.existing)
			else
				toast_error(cx2, err)
			end
			return
		end
		open_tab(cx2, res)
		after_change(cx2, root)
		local parts: { string } = { res.path }
		local warnings = join_or_nil(res.warnings, "; ")
		if warnings then
			table.insert(parts, warnings)
		end
		if type(res.carried) == "table" and #res.carried > 0 then
			table.insert(parts, "carried " .. #res.carried .. " ignored file(s)")
		end
		cx2:toast("success", tostring(res.status) .. NO_BREAK_SPACE .. "worktree", table.concat(parts, " · "))
	end)
end

local function add_row(root: string, id: string, title: string, createArgs: { string }, ids: { string })
	rootOfLiveRow[id] = root
	table.insert(ids, id)
	tern.command({
		id = id,
		title = title,
		icon = "branch",
		group = "Worktrees",
		available = function(cx: WindowCx): boolean
			if rootOfLiveRow[id] ~= root then
				return false
			end
			local focused = cx.session:focused()
			local cwd = if focused ~= nil then cwdOfPane[focused] else nil
			return cwd ~= nil and rootOfDir[cwd] == root
		end,
		run = function(cx: WindowCx)
			create(cx, root, createArgs)
		end,
	})
end

local function pr_label(pr: PullRequest): string
	return "#" .. tostring(pr.number) .. " " .. tostring(pr.title)
end

local function branches_with_worktree(res: BranchesResult): { [string]: boolean }
	local hasWorktree: { [string]: boolean } = {}
	for _, w in ipairs(res.worktrees or {}) do
		if type(w.branch) == "string" then
			hasWorktree[w.branch] = true
		end
	end
	return hasWorktree
end

local function register_rows(root: string, res: BranchesResult, prs: { PullRequest })
	local name: string = if type(res.name) == "string" then res.name else basename(root)
	local prefix = "wt-" .. fnv1a(root) .. "-"
	local hasWorktree = branches_with_worktree(res)
	local ids: { string } = {}
	for _, pr in ipairs(prs) do
		local n = tostring(pr.number)
		add_row(root, prefix .. fnv1a("pr:" .. n), name .. ": " .. pr_label(pr), { "--pr", n }, ids)
	end
	for _, branch in ipairs(res.branches or {}) do
		if type(branch) == "string" then
			local title = name .. ": " .. branch .. (if hasWorktree[branch] then " · worktree" else "")
			add_row(root, prefix .. fnv1a(branch), title, { "--branch", branch }, ids)
		end
	end
	local currentIds: { [string]: boolean } = {}
	for _, id in ipairs(ids) do
		currentIds[id] = true
	end
	local state = state_of(root)
	for _, id in ipairs(state.rows or {}) do
		if not currentIds[id] then
			rootOfLiveRow[id] = nil
		end
	end
	state.rows = ids
end

local function fetch_interval_ms(cx: WindowCx): number
	local ok, minutes = pcall(function()
		return cx.settings:get("git.auto_fetch_minutes")
	end)
	if ok and type(minutes) == "number" and minutes >= 0 then
		return minutes * 60000
	end
	return 5 * 60000
end

local function pr_list_failed(res: BranchesResult): boolean
	for _, w in ipairs(res.warnings or {}) do
		if type(w) == "string" and string.find(w, "pr list failed:", 1, true) == 1 then
			return true
		end
	end
	return false
end

refresh = function(cx: WindowCx, root: string)
	local state = state_of(root)
	if state.refreshing then
		state.again = true
		return
	end
	state.refreshing = true
	local interval = fetch_interval_ms(cx)
	local lastNetworkAt = state.networkAt
	local useNetwork = interval > 0 and (lastNetworkAt == nil or tern.now() - lastNetworkAt >= interval)
	local args = { "branches", "--repo", root }
	if useNetwork then
		state.networkAt = tern.now()
	else
		table.insert(args, "--offline")
	end
	cli(args, function(res: BranchesResult, err, cx2)
		state.refreshing = false
		if err == nil then
			if useNetwork and not pr_list_failed(res) then
				state.prs = if type(res.prs) == "table" then res.prs else {}
			end
			register_rows(root, res, state.prs or {})
		end
		if state.again then
			state.again = false
			refresh(cx2, root)
		end
	end)
end

local function remember_cwd(pane: number, cwd: string?)
	cwdOfPane[pane] = known_cwd(cwd)
end

local function refresh_dir(cx: WindowCx, cwd: string?)
	local dir = known_cwd(cwd)
	if dir == nil then
		return
	end
	local root = rootOfDir[dir]
	if root ~= nil then
		if type(root) == "string" then
			refresh(cx, root)
		end
		return
	end
	if resolving[dir] then
		return
	end
	resolving[dir] = true
	cli({ "resolve", dir }, function(res: ResolveResult, err, cx2)
		resolving[dir] = nil
		if err ~= nil then
			return
		end
		learn_roots(res)
		local found = rootOfDir[dir]
		if type(found) == "string" then
			refresh(cx2, found)
		end
	end)
end

local repo_picker: (cx: WindowCx) -> ()

local function new_branch(cx: WindowCx, root: string, name: string, default: string, value: string?)
	ask_text(cx, {
		value = value,
		placeholder = "New branch from " .. default .. " in " .. name,
		icon = "branch",
		action = "create",
	}, function(text, cx2, err)
		if err ~= nil or text == nil or text == "" then
			return
		end
		create(cx2, root, { "--branch=" .. text, "--new" }, function(cx3)
			new_branch(cx3, root, name, default, text)
		end)
	end)
end

local function branch_picker(cx: WindowCx, root: string)
	local started = startCount
	cli_or_toast({ "branches", "--repo", root }, function(res: BranchesResult, cx2)
		if startCount ~= started then
			return
		end
		local name = tostring(res.name)
		local default = tostring(res.default)
		local hasWorktree = branches_with_worktree(res)
		local items: { PickItem } = {
			{ id = "new", label = "New branch…", detail = "from " .. default, icon = "plus" },
			{ id = "other", label = "Other repo…", icon = "folder" },
		}
		for _, pr in ipairs(res.prs or {}) do
			table.insert(items, {
				id = "pr:" .. tostring(pr.number),
				label = pr_label(pr) .. " · " .. tostring(pr.branch),
				group = "Pull requests",
				icon = "merge",
			})
		end
		for _, branch in ipairs(res.branches or {}) do
			table.insert(items, {
				id = "b:" .. branch,
				label = branch,
				detail = if hasWorktree[branch] then "worktree" else nil,
				group = "Branches",
				icon = "branch",
			})
		end
		choose(
			cx2,
			{ placeholder = "Search branches in " .. name, icon = "branch", action = "open", items = items },
			function(item, cx3, err)
				if err ~= nil or item == nil then
					return
				end
				local id: string = item.id
				local branch = string.match(id, "^b:(.*)$")
				local pr = string.match(id, "^pr:(.*)$")
				if id == "new" then
					new_branch(cx3, root, name, default)
				elseif id == "other" then
					repo_picker(cx3)
				elseif branch ~= nil then
					create(cx3, root, { "--branch=" .. branch })
				elseif pr ~= nil then
					create(cx3, root, { "--pr", pr })
				end
			end
		)
	end)
end

local function github_picker(cx: WindowCx)
	cx:toast("info", "Loading GitHub repos…")
	cli_or_toast({ "repos" }, function(res: ReposResult, reposCx)
		local items: { PickItem } = {}
		for _, r in ipairs(res.repos or {}) do
			local nameWithOwner = r.nameWithOwner
			table.insert(items, {
				id = "gh:" .. nameWithOwner,
				label = nameWithOwner,
				detail = if type(r.description) == "string" and r.description ~= "" then r.description else nil,
				group = string.match(nameWithOwner, "^([^/]+)/") or nameWithOwner,
				icon = "globe",
			})
		end
		if #items == 0 then
			reposCx:toast("info", "No GitHub repositories")
			return
		end
		choose(reposCx, {
			placeholder = "Search GitHub repositories",
			icon = "globe",
			action = "clone",
			items = items,
		}, function(item, _, err)
			local nameWithOwner = if err == nil and item ~= nil then string.match(item.id, "^gh:(.*)$") else nil
			if nameWithOwner == nil then
				return
			end
			cli_or_toast({ "clone", nameWithOwner }, function(clone: RootResult, cloneCx)
				branch_picker(cloneCx, clone.root)
			end)
		end)
	end)
end

local function make_repo(owner: string, name: string, visibility: string)
	cli_or_toast(
		{ "new-repo", owner .. "/" .. name, "--visibility", visibility },
		function(newRepo: RootResult, createdCx)
			branch_picker(createdCx, newRepo.root)
		end
	)
end

local function ask_visibility(cx: WindowCx, owner: string, name: string)
	choose(cx, {
		placeholder = "Visibility of " .. owner .. "/" .. name,
		action = "create",
		items = {
			{ id = "private", label = "Private", icon = "lock" },
			{ id = "public", label = "Public", icon = "globe" },
		},
	}, function(item, _, err)
		if err == nil and item ~= nil then
			make_repo(owner, name, item.id)
		end
	end)
end

local function ask_name(cx: WindowCx, owner: string)
	ask_text(cx, {
		placeholder = "Name of the new repository under " .. owner,
		icon = "folder-plus",
		action = "continue",
	}, function(text, nameCx, err)
		if err == nil and text ~= nil and text ~= "" then
			ask_visibility(nameCx, owner, text)
		end
	end)
end

local function ask_owner(cx: WindowCx, ownerNames: { string })
	local owners: { PickItem } = {}
	for _, o in ipairs(ownerNames) do
		table.insert(owners, { id = o, label = o, icon = "user" })
	end
	if #owners == 0 then
		cx:toast("info", "No GitHub owners")
		return
	end
	choose(
		cx,
		{ placeholder = "Search owners", icon = "user", action = "choose", items = owners },
		function(item, ownerCx, err)
			if err == nil and item ~= nil then
				ask_name(ownerCx, item.id)
			end
		end
	)
end

local function new_repo(cx: WindowCx)
	cli_or_toast({ "repos" }, function(res: ReposResult, reposCx)
		ask_owner(reposCx, res.owners or {})
	end)
end

repo_picker = function(cx: WindowCx)
	local items: { PickItem } = {}
	for _, r in ipairs(localRepos) do
		table.insert(items, {
			id = "local:" .. r.root,
			label = r.name,
			detail = short_path(r.root),
			group = "Open sessions",
			icon = "folder",
		})
	end
	table.insert(items, { id = "github", label = "Browse GitHub repos…", group = "GitHub", icon = "globe" })
	table.insert(items, { id = "newrepo", label = "Create new GitHub repo…", group = "GitHub", icon = "folder-plus" })
	choose(
		cx,
		{ placeholder = "Search repositories", icon = "folder", action = "open", items = items },
		function(item, cx2, err)
			if err ~= nil or item == nil then
				return
			end
			local id: string = item.id
			local root = string.match(id, "^local:(.*)$")
			if root ~= nil then
				branch_picker(cx2, root)
			elseif id == "github" then
				github_picker(cx2)
			elseif id == "newrepo" then
				new_repo(cx2)
			end
		end
	)
end

local function start(cx: WindowCx)
	startCount += 1
	local started = startCount
	flush(cx)
	resolve_sessions(cx, function(cx2)
		if startCount ~= started then
			return
		end
		local cur = session_index(cx2).current
		local root = if cur ~= nil then rootOfSession[cur.id] else nil
		if root ~= nil then
			branch_picker(cx2, root)
		else
			repo_picker(cx2)
		end
	end)
end

local function run_remove(
	cx: WindowCx,
	path: string,
	force: boolean,
	done: (cx: WindowCx) -> (),
	stop: (cx: WindowCx) -> ()
)
	local args = { "remove", path, "--keep-tab" }
	if force then
		table.insert(args, "--force")
	end
	cli(args, function(res: RemoveResult, err, cx2)
		if err ~= nil then
			cx2:toast("error", "Teardown failed: " .. short_path(path), failure_message(err, path))
			choose(cx2, {
				placeholder = "Teardown failed · " .. short_path(path),
				icon = "branch",
				items = {
					{ id = "retry", label = "Retry" },
					{ id = "force", label = "Force delete", detail = "discards uncommitted work" },
				},
			}, function(item, cx3, pickErr)
				if pickErr == nil and item ~= nil and item.id == "retry" then
					run_remove(cx3, path, false, done, stop)
				elseif pickErr == nil and item ~= nil and item.id == "force" then
					run_remove(cx3, path, true, done, stop)
				else
					stop(cx3)
				end
			end)
			return
		end
		cx2:toast(
			"success",
			"deleted" .. NO_BREAK_SPACE .. "worktree",
			join_or_nil(res.warnings, "; ") or short_path(path)
		)
		set_entry(res.removed, nil)
		after_change(cx2)
		done(cx2)
	end)
end

local function confirm_teardown(cx: WindowCx, tab: number?, paths: { string }, index: number): boolean
	local path = paths[index]
	if path == nil then
		if tab ~= nil then
			close_tab(cx, tab)
		end
		return true
	end
	local function advance(cx2: WindowCx)
		confirm_teardown(cx2, tab, paths, index + 1)
	end
	local function stop(cx2: WindowCx)
		if tab == nil then
			advance(cx2)
		end
	end
	local function keep(cx2: WindowCx)
		if tab ~= nil then
			handled[path] = true
		end
		advance(cx2)
	end
	local policy = config().teardown
	local where = if tab ~= nil then "Closing worktree tab · " else "Worktree tab closed · "
	-- `choose` already toasts a pick `err`. An `err` counts as Keep, so a closing tab can always close.
	choose(cx, {
		placeholder = where .. short_path(path),
		icon = "branch",
		items = {
			{ id = "keep", label = "Keep worktree", detail = "closes the tab, keeps the worktree" },
			{ id = "teardown", label = "Tear down", detail = POLICY[policy] or ("Teardown policy: " .. policy) },
		},
	}, function(item, cx2, err)
		if err == nil and item ~= nil and item.id == "teardown" then
			run_remove(cx2, path, false, function(cx3)
				if tab ~= nil then
					handled[path] = true
				end
				advance(cx3)
			end, stop)
		elseif err ~= nil or (item ~= nil and item.id == "keep") then
			keep(cx2)
		else
			stop(cx2)
		end
	end)
	return true
end

local function intercept(cx: WindowCx, tab: number?): boolean
	if tab == nil then
		return false
	end
	local paths: { string } = {}
	for _, path in ipairs(tab_paths(cx, tab)) do
		if not pane_under(cx, path, tab) then
			table.insert(paths, path)
		end
	end
	if #paths == 0 then
		return false
	end
	return confirm_teardown(cx, tab, paths, 1)
end

tern.command({
	id = "new",
	title = "New worktree tab",
	icon = "branch",
	keys = config().hotkeys.new,
	run = start,
})

tern.override("close_tab", function(cx: WindowCx): boolean?
	local focused = cx.session:focused()
	if focused == nil then
		return false
	end
	return intercept(cx, cx.session:tab_of(focused))
end)

tern.override("close_pane", function(cx: WindowCx): boolean?
	local focused = cx.session:focused()
	if focused == nil then
		return false
	end
	local tab = cx.session:tab_of(focused)
	for _, info in ipairs(cx.session:tabs()) do
		if info.id == tab then
			return info.panes == 1 and intercept(cx, tab)
		end
	end
	return false
end)

tern.on("window_start", function(cx: WindowCx)
	rebuild_managed(cx)
	for _, pane in ipairs(cx.session:panes()) do
		remember_cwd(pane.pane, pane.cwd)
	end
	resolve_sessions(cx, function(cx2)
		for _, repo in ipairs(localRepos) do
			refresh(cx2, repo.root)
		end
	end)
	list_all(function(res, cx2)
		local learned = if res ~= nil and type(res.root) == "string" then without_trailing_slash(res.root) else nil
		if learned ~= nil and learned ~= "" and learned ~= ROOT then
			ROOT = learned
			if env("TERN_WT_HOME") == nil then
				pcall(tern.kv.set, ROOT_KEY, ROOT)
			end
			table.clear(managed)
			rebuild_managed(cx2)
		end
	end)
end)

for _, name in ipairs({ "tab_created", "pane_created" }) do
	tern.on(name, function(_ev: any, cx: WindowCx)
		rebuild_managed(cx)
	end)
end

tern.on("cwd", function(ev: CwdEvent, cx: WindowCx)
	rebuild_managed(cx)
	remember_cwd(ev.pane, ev.path)
	if ev.pane == cx.session:focused() then
		refresh_dir(cx, ev.path)
	end
	if is_under(ev.path, ROOT) and not in_index(ev.path) then
		refresh_index()
	end
end)

tern.on("focus", function(ev: FocusEvent, cx: WindowCx)
	local pane = cx.session:pane(ev.pane)
	if pane ~= nil then
		remember_cwd(ev.pane, pane.cwd)
		if ev.pane == cx.session:focused() then
			refresh_dir(cx, pane.cwd)
		end
		if in_index(pane.cwd) then
			refresh_index()
		end
	end
end)

tern.on("command_finished", function(ev: CommandFinishedEvent, cx: WindowCx)
	local cwd: string? = cwdOfPane[ev.pane]
	if cwd == nil then
		local pane = cx.session:pane(ev.pane)
		cwd = if pane ~= nil then pane.cwd else nil
	end
	refresh_dir(cx, cwd)
	if in_index(cwd) then
		refresh_index()
	end
end)

tern.on("pane_closed", function(ev: PaneEvent, _cx: WindowCx)
	cwdOfPane[ev.pane] = nil
end)

tern.on("tab_closed", function(ev: TabEvent, cx: WindowCx)
	flush(cx)
	local paths = managed[ev.tab]
	managed[ev.tab] = nil
	if paths == nil then
		return
	end
	local open: { string } = {}
	for _, path in ipairs(paths) do
		if not handled[path] and tern.fs.exists(path) and not pane_under(cx, path, nil) then
			table.insert(open, path)
		end
		handled[path] = nil
	end
	if #open > 0 then
		confirm_teardown(cx, nil, open, 1)
	end
end)

local function export_args(...: any): ({ any }, WindowCx, any)
	local n = select("#", ...)
	local cx, call = select(n - 1, ...)
	local args: { any } = {}
	for i = 1, n - 2 do
		args[i] = (select(i, ...))
	end
	return args, cx, call
end

local function err_text(err: any): string
	return tostring(err.code) .. ": " .. tostring(err.message)
end

local function reply_to<T>(call: any): CliCb<T>
	return function(res, err, _cx)
		if err ~= nil then
			call:fail(err_text(err))
		else
			call:reply(res)
		end
	end
end

tern.carly.export("create", {
	sig = "(repo: string, branch: string, new: boolean?) -> {path: string, status: string}",
	doc = "Create or reuse a worktree for branch in repo (a dir inside the repo) and open it as a tab.",
}, function(...: any): ...any
	local args, _cx, call = export_args(...)
	local repo, branch, isNew = args[1], args[2], args[3]
	if type(repo) ~= "string" or type(branch) ~= "string" then
		error("create: repo and branch must be strings", 0)
	end
	local argv = { "create", "--repo", repo, "--branch", branch, "--no-tab" }
	if isNew == true then
		table.insert(argv, "--new")
	end
	cli_or_else(argv, function(_cx, err)
		call:fail(err_text(err))
	end, function(res: CreateResult, cx2)
		resolve_sessions(cx2, function(cx3)
			local ok, openErr = pcall(function()
				open_tab(cx3, res)
			end)
			if not ok then
				res.warnings = res.warnings or {}
				table.insert(res.warnings, "tab not opened: " .. tostring(openErr))
			end
			if type(res.repo) == "string" then
				after_change(cx3, res.repo)
			end
			call:reply(res)
		end)
	end)
	return call:wait(120000)
end)

tern.carly.export("list", {
	sig = "() -> {worktrees: {any}}",
	doc = "List the managed worktrees under the worktree root.",
}, function(...: any): ...any
	local _args, _cx, call = export_args(...)
	local reply: CliCb<ListResult> = reply_to(call)
	cli({ "list" }, reply)
	return call:wait(120000)
end)

tern.carly.export("remove", {
	sig = "(path: string, force: boolean?) -> {removed: string}",
	doc = "Tear down the managed worktree at path under the teardown policy, and close its tabs. Force discards uncommitted work.",
}, function(...: any): ...any
	local args, _cx, call = export_args(...)
	local path, force = args[1], args[2]
	if type(path) ~= "string" then
		error("remove: path must be a string", 0)
	end
	local argv = { "remove", path }
	if force == true then
		table.insert(argv, "--force")
	end
	cli(argv, function(res: RemoveResult, err, cx2)
		if err == nil then
			set_entry(res.removed, nil)
			after_change(cx2)
		end
		reply_to(call)(res, err, cx2)
	end)
	return call:wait(120000)
end)
