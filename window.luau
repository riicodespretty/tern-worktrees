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

-- The worktree root that a `list --all` answer gave last, kept in kv, or nil until the first answer.
local function remembered_root(): string?
	local ok, remembered = pcall(tern.kv.get, ROOT_KEY)
	if ok and type(remembered) == "string" and remembered ~= "" then
		return without_trailing_slash(remembered)
	end
	return nil
end

local ROOT: string? = remembered_root()
local DEFAULT_KEYS = { "cmd+shift+w" }
local POLICY = {
	worktree = "removes worktree, keeps branch",
	["worktree+merged-branch"] = "removes worktree, deletes branch if merged",
	["worktree+branch"] = "removes worktree, deletes branch",
}

type CliCb<T> = (result: T, err: any, cx: WindowCx) -> ()
type PullRequest = { number: number, title: string, branch: string }
type BranchWorktree = { branch: string?, path: string, main: boolean? }
type BranchesResult = {
	name: string,
	default: string,
	branches: { string },
	prs: { PullRequest },
	prsFailed: boolean?,
	worktrees: { BranchWorktree },
	warnings: { string },
}
type SetupLine = { line: string, typed: boolean }
type CreateResult = {
	branch: string,
	carried: { string },
	owner: "tern" | "omp" | "main",
	path: string,
	repo: string,
	setup: SetupLine?,
	status: string,
	warnings: { string },
}
type GithubRepo = { nameWithOwner: string, description: string? }
type ReposResult = { owners: { string }, repos: { GithubRepo } }
type ResolvedDir = { dir: string, root: string?, name: string? }
type ResolveResult = { repos: { ResolvedDir } }
type RemoveResult = {
	removed: string,
	repo: string,
	branch: string?,
	branchDeleted: boolean?,
	branchKept: ("policy" | "not_merged" | "not_deleted")?,
	warnings: { string },
}
type ListResult = { root: string, worktrees: { any } }
type RootResult = { root: string }
type ConfigResult = { teardown: string }
type SetupResult = { links: { { path: string, target: string, action: "created" | "kept" | "replaced" } } }
type IndexEntry = { main: string, branch: string?, changed: number, owner: "tern" | "omp" }
type SessionIndex = {
	byId: { [number]: SessionInfo },
	byTab: { [number]: SessionInfo },
	current: SessionInfo?,
}
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
local refresh_branches: (cx: WindowCx, root: string) -> ()

local function flush(cx: WindowCx)
	for _, text in ipairs(queuedErrors) do
		cx:toast("error", text)
	end
	table.clear(queuedErrors)
end

local CLI_OPTIONS = { timeout_ms = 120000 }

local function cli<T>(args: { string }, cb: CliCb<T>)
	tern.process.run({ CLI, table.unpack(args) }, CLI_OPTIONS, function(r: ProcessResult, cx: WindowCx?)
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

-- Whether a run that started at `startedAt` can still answer: it started at most the timeout of `cli` before.
local function in_flight(startedAt: number?): boolean
	return startedAt ~= nil and tern.now() - startedAt <= CLI_OPTIONS.timeout_ms
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
local worktreeIndex = stored_index({})
-- The time when this window last set or deleted each entry. A `list --all` answer keeps the value of this window
-- for each entry that changed at or after the time that the `list --all` started.
local changedAt: { [string]: number } = {}
local listing: number? = nil
local listAgain = false
local refreshPending = false
local listStartedAt: number? = nil

-- Whether `a` and `b` differ in what a worktree segment shows: a worktree, its branch or its number of changed files.
local function segments_differ(a: { [string]: IndexEntry? }, b: { [string]: IndexEntry? }): boolean
	for path, entry in pairs(a) do
		local otherEntry = b[path]
		if
			entry ~= nil
			and (otherEntry == nil or entry.branch ~= otherEntry.branch or entry.changed ~= otherEntry.changed)
		then
			return true
		end
	end
	for path in pairs(b) do
		if a[path] == nil then
			return true
		end
	end
	return false
end

-- Writes `nextIndex` as the worktree index, and redraws the status line when a worktree segment changes.
local function write_index(nextIndex: { [string]: IndexEntry? })
	local before = worktreeIndex
	worktreeIndex = nextIndex
	pcall(tern.kv.set, INDEX_KEY, worktreeIndex)
	if segments_differ(before, worktreeIndex) then
		tern.chrome.refresh()
	end
end

-- Sets or deletes one entry. Other windows write the same kv key, so this reads kv again and changes only `path`.
local function set_entry(path: string, entry: IndexEntry?)
	local merged = table.clone(stored_index(worktreeIndex))
	merged[path] = entry
	changedAt[path] = tern.now()
	write_index(merged)
end

-- The worktree index entry of `cwd` and its path: the longest index path that is `cwd` or a parent folder of it.
local function index_lookup(cwd: string?): (string?, IndexEntry?)
	local found: string? = nil
	for path in pairs(worktreeIndex) do
		if is_under(cwd, path) and (found == nil or #path > #found) then
			found = path
		end
	end
	return found, if found ~= nil then worktreeIndex[found] else nil
end

-- The path of the managed worktree of `cwd`: the index path of `cwd` when its entry has owner `tern`.
local function managed_worktree(cwd: string?): string?
	local path, entry = index_lookup(cwd)
	return if entry ~= nil and entry.owner == "tern" then path else nil
end

-- Writes the managed worktrees of each tab with panes into `managed`, from the worktree index in memory.
local function rebuild_managed(cx: WindowCx)
	flush(cx)
	local found: { [number]: { string } } = {}
	for _, pane in ipairs(cx.session:panes()) do
		local tab = pane.tab
		if tab ~= nil then
			local paths = found[tab] or {}
			found[tab] = paths
			local path = managed_worktree(pane.cwd)
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

local function apply_list(res: ListResult, startedAt: number)
	local fresh: { [string]: IndexEntry? } = {}
	for _, w in ipairs(res.worktrees or {}) do
		if type(w.path) == "string" and type(w.repo) == "string" then
			fresh[w.path] = {
				main = w.repo,
				branch = if type(w.branch) == "string" then w.branch else nil,
				changed = if type(w.changed) == "number" then w.changed else 0,
				owner = if w.owner == "tern" then "tern" else "omp",
			}
		end
	end
	for path, at in pairs(changedAt) do
		if at >= startedAt then
			fresh[path] = worktreeIndex[path]
		else
			changedAt[path] = nil
		end
	end
	write_index(fresh)
end

local refresh_index: () -> ()

-- Runs `list --all`, writes the worktree index from its answer, and passes the answer, or nil on an error, to `cb`.
-- When a later `list_all` starts before the answer, the answer is dropped and `cb` does not run.
local function list_all(cb: (res: ListResult?, cx: WindowCx) -> ())
	local startedAt = tern.now()
	listing = startedAt
	listStartedAt = startedAt
	cli({ "list", "--all" }, function(res: ListResult, err, cx2)
		if listing ~= startedAt then
			return
		end
		listing = nil
		if err == nil then
			apply_list(res, startedAt)
			rebuild_managed(cx2)
		end
		cb(if err == nil then res else nil, cx2)
		if listAgain then
			listAgain = false
			refresh_index()
		end
	end)
end

-- Refreshes the worktree index: at most one `list --all` at a time, and at most one each INDEX_GAP_MS. A refresh
-- request inside that gap runs one time, at the end of the gap. A `list --all` with no answer after the timeout of
-- `cli` is lost: the next refresh starts a new one, and the answer of the lost one is dropped.
refresh_index = function()
	if in_flight(listing) then
		listAgain = true
		return
	end
	if refreshPending then
		return
	end
	local waitMs = if listStartedAt == nil then 0 else listStartedAt + INDEX_GAP_MS - tern.now()
	if waitMs > 0 then
		refreshPending = true
		tern.timer(waitMs, function()
			refreshPending = false
			refresh_index()
		end)
		return
	end
	list_all(function() end)
end

local function basename(path: string): string
	return string.match(path, "([^/]+)/*$") or path
end

local function warn_config()
	if not configWarned then
		configWarned = true
		table.insert(queuedErrors, "tern-worktrees: invalid config.json, using defaults")
	end
end

-- The hotkeys of the New worktree tab command, from the options file.
local function new_tab_keys(): { string }
	local path = tern.plugin.data .. "/config.json"
	if not tern.fs.exists(path) then
		return DEFAULT_KEYS
	end
	local ok, decoded = pcall(function()
		return tern.json.decode(tern.fs.read(path))
	end)
	if not ok or type(decoded) ~= "table" then
		warn_config()
		return DEFAULT_KEYS
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
	return newKeys
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

-- The session to switch to before an effect in session `sid`, or nil when no switch is needed. With `strict` false,
-- a switch runs only when the current session is known and is not `sid`. With `strict` true, a switch runs unless the
-- current session is known to be `sid`.
local function switch_for(index: SessionIndex, sid: number, strict: boolean): number?
	local current = index.current
	if current == nil then
		return if strict then sid else nil
	end
	return if current.id ~= sid then sid else nil
end

local function switch_to(cx: WindowCx, sid: number?)
	if sid ~= nil then
		cx.sessions:switch(sid)
	end
end

local function tab_paths(cx: WindowCx, tab: number): { string }
	local paths: { string } = {}
	for _, pane in ipairs(cx.session:panes()) do
		if pane.tab == tab then
			local path = managed_worktree(pane.cwd)
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
	switch_to(cx, if sid ~= nil then switch_for(index, sid, false) else nil)
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

local MAX_PATH = 72

local function short_path(path: string): string
	local home = env("HOME")
	local short = path
	local root = ROOT
	if home ~= nil and string.sub(path, 1, #home + 1) == home .. "/" then
		short = "~" .. string.sub(path, #home + 1)
	elseif root ~= nil and string.sub(path, 1, #root + 1) == root .. "/" then
		short = "…/worktrees" .. string.sub(path, #root + 1)
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

local function sentence_case(text: string): string
	return string.upper(string.sub(text, 1, 1)) .. string.sub(text, 2)
end

local MAX_TOAST_DETAIL = 50

local function elide_start(text: string, max: number): string
	local length = utf8.len(text) or #text
	if length <= max then
		return text
	end
	local tailStartByte = utf8.offset(text, length - (max - 1) + 1) or (#text - (max - 1) + 1)
	return "…" .. string.sub(text, tailStartByte)
end

-- The `:next` callback of a `cx:pick` or `cx:prompt` request. It returns at once when its `cx` is nil. Else it shows
-- `err`, when set, in an error toast titled `title`, then calls `cb`.
local function settle<T>(
	title: string,
	cb: (result: T?, cx: WindowCx, err: string?) -> ()
): (result: T?, err: string?, cx: WindowCx?) -> ()
	return function(result: T?, err: string?, cx: WindowCx?)
		if cx == nil then
			return
		end
		if err ~= nil then
			cx:toast("error", title, err)
		end
		cb(result, cx, err)
	end
end

local function choose(cx: WindowCx, opts: PickOptions, cb: (id: string?, cx: WindowCx, err: string?) -> ())
	cx:pick(opts):next(settle("Picker failed", function(item: PickItem?, cx2: WindowCx, err: string?)
		cb(if err == nil and item ~= nil then item.id else nil, cx2, err)
	end))
end

local function prompt_text(cx: WindowCx, opts: PromptOptions, cb: (text: string?, cx: WindowCx, err: string?) -> ())
	cx:prompt(opts):next(settle("Prompt failed", cb))
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

-- The files of a `dirty_worktree` error `err` that a toast shows: its `changes`, its `hardToRebuild` files as
-- `ignored`, and how many of them the cap leaves out.
local function list_dirty_files(err: any): DirtyListing
	local shown: DirtyListing = { changes = {}, ignored = {}, omitted = 0 }
	local changes: { string } = {}
	local ignored: { string } = {}
	if type(err.changes) == "table" then
		for _, entry in ipairs(err.changes) do
			table.insert(changes, tostring(entry))
		end
	end
	if type(err.hardToRebuild) == "table" then
		for _, file in ipairs(err.hardToRebuild) do
			table.insert(ignored, tostring(file))
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

-- The cause of a failed `remove` of the worktree at `path`: the files with work to lose of a `dirty_worktree`, else
-- the message with the folder name of the worktree in place of `path`, then the saved files when there are some.
local function failure_message(err: any, path: string): string
	local summary = if err.code == "dirty_worktree" then dirty_summary(list_dirty_files(err)) else ""
	local parts: { string } = {
		if summary ~= "" then summary else replace_plain(tostring(err.message), path, basename(path)),
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

-- Tab placement: the repository of each session, where the worktree tab of a `create` answer goes, and the effects
-- that put it there.

-- The repository root of each session: the root of the first pane, in pane order, of its tabs. A session of
-- `previous` that is open and has no tab keeps its root. A session that closed drops out.
local function repos_of_sessions(
	panes: { PaneInfo },
	index: SessionIndex,
	rootOf: { [string]: string | false },
	previous: { [number]: string }
): { [number]: string }
	local repos: { [number]: string } = {}
	for _, pane in ipairs(panes) do
		local sid = session_of_tab(index, pane.tab)
		local root = pane.cwd and rootOf[pane.cwd]
		if sid ~= nil and type(root) == "string" and repos[sid] == nil then
			repos[sid] = root
		end
	end
	for id, root in pairs(previous) do
		local entry = index.byId[id]
		if entry ~= nil and #entry.tabs == 0 then
			repos[id] = root
		end
	end
	return repos
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
		local repos = repos_of_sessions(cx2.session:panes(), session_index(cx2), rootOfDir, rootOfSession)
		table.clear(rootOfSession)
		for id, root in pairs(repos) do
			rootOfSession[id] = root
		end
		cb(cx2)
	end)
end

-- Where the worktree tab goes:
-- - `open`: a pane in the worktree has a tab. The plugin focuses it, after a switch to `switch` when set.
-- - `new_tab`: the repository session `session` has a tab. A new tab opens there, after a switch to `switch` when
--   set, with the parked pane `parked` when it moves, else with a new shell.
-- - `empty_session`: the repository session `session` has no tab. A new tab opens there, after a switch to `switch`
--   when set, and the parked pane `parked` goes into it in place of its shell.
-- - `new_session`: the repository has no session. A new session named `name` opens, and the parked pane `parked`
--   goes into its first tab in place of its shell.
type Placement =
	{ kind: "open", pane: number, tab: number?, switch: number? }
	| { kind: "new_tab", session: number, switch: number?, parked: number? }
	| { kind: "empty_session", session: number, switch: number?, parked: number? }
	| { kind: "new_session", name: string, parked: number? }

-- Where the worktree tab of `path`, in the repository `repo`, goes. The repository session is the open session with
-- the lowest id of the sessions whose root in `repoOf` is `repo`. Reads facts only and runs no effect.
local function place(
	path: string,
	repo: string,
	panes: { PaneInfo },
	index: SessionIndex,
	repoOf: { [number]: string }
): Placement
	local parked: number? = nil
	for _, pane in ipairs(panes) do
		if is_under(pane.cwd, path) then
			if pane.parked then
				parked = parked or pane.pane
			else
				local sid = session_of_tab(index, pane.tab)
				local switch = if sid ~= nil then switch_for(index, sid, false) else nil
				return { kind = "open", pane = pane.pane, tab = pane.tab, switch = switch }
			end
		end
	end
	local sid: number? = nil
	for id, root in pairs(repoOf) do
		if root == repo and index.byId[id] ~= nil and (sid == nil or id < sid) then
			sid = id
		end
	end
	if sid == nil then
		return { kind = "new_session", name = basename(repo), parked = parked }
	end
	local switch = switch_for(index, sid, true)
	if #index.byId[sid].tabs == 0 then
		return { kind = "empty_session", session = sid, switch = switch, parked = parked }
	end
	return { kind = "new_tab", session = sid, switch = switch, parked = parked }
end

-- Unparks `parked` and moves it to a new tab of session `sid`. Returns that tab, or nil when the pane did not move.
-- A pane that unparks and does not move parks again.
local function move_parked(cx: WindowCx, parked: number?, sid: number): number?
	if parked == nil or not cx.layout:unpark(parked) then
		return nil
	end
	local tab = cx.layout:move_to_new_tab(parked, sid)
	if tab == nil then
		cx.layout:park(parked)
	end
	return tab
end

-- Puts the parked pane `parked` into the new tab `freshTab` in place of its shells. Returns the tab of the worktree
-- and its new shell: the tab of `parked` and no shell when it unparks, else `freshTab` and its first pane.
local function fill_fresh_tab(cx: WindowCx, freshTab: number?, parked: number?): (number?, number?)
	if freshTab == nil then
		return nil, nil
	end
	if parked ~= nil then
		local shells: { number } = {}
		for _, pane in ipairs(cx.session:panes()) do
			if pane.tab == freshTab then
				table.insert(shells, pane.pane)
			end
		end
		if cx.layout:unpark(parked) then
			for _, shell in ipairs(shells) do
				cx.layout:close(shell)
			end
			return cx.session:tab_of(parked), nil
		end
	end
	for _, pane in ipairs(cx.session:panes()) do
		if pane.tab == freshTab then
			return freshTab, pane.pane
		end
	end
	return freshTab, nil
end

-- Opens or focuses the tab of the worktree of `res`. Returns the pane of a new shell in it, or nil and the reason
-- that no new shell opened: no tab opened, the tab was open before, or the tab holds no new shell.
local function open_tab(cx: WindowCx, res: CreateResult): (number?, string?)
	local path = res.path
	local plan = place(path, res.repo, cx.session:panes(), session_index(cx), rootOfSession)
	local tab: number? = nil
	local shellPane: number? = nil
	if plan.kind == "open" then
		switch_to(cx, plan.switch)
		cx.layout:focus(plan.pane)
		tab = plan.tab
	elseif plan.kind == "new_tab" then
		switch_to(cx, plan.switch)
		tab = move_parked(cx, plan.parked, plan.session)
		if tab == nil then
			shellPane = cx.layout:new_tab({ cwd = path })
			tab = if shellPane ~= nil then cx.session:tab_of(shellPane) else nil
		end
	elseif plan.kind == "empty_session" then
		switch_to(cx, plan.switch)
		local pane = cx.layout:new_tab({ cwd = path })
		tab, shellPane = fill_fresh_tab(cx, if pane ~= nil then cx.session:tab_of(pane) else nil, plan.parked)
	else
		local created = cx.sessions:create({ name = plan.name, cwd = path })
		rootOfSession[created.id] = res.repo
		local info = session_index(cx).byId[created.id]
		tab, shellPane = fill_fresh_tab(cx, if info ~= nil then info.tabs[1] else nil, plan.parked)
	end
	if tab ~= nil and plan.kind ~= "open" then
		cx.layout:name_tab(tab, res.branch)
	end
	if tab ~= nil and res.owner == "tern" then
		local paths = managed[tab] or {}
		managed[tab] = paths
		if table.find(paths, path) == nil then
			table.insert(paths, path)
		end
	end
	if shellPane ~= nil then
		return shellPane, nil
	elseif tab == nil then
		return nil, "no tab opened"
	elseif plan.kind == "open" then
		return nil, "the tab was open before"
	end
	return nil, "no new shell in the tab"
end

local SETUP_POLL_MS = 200
local SETUP_PROMPT_MS = 30000

-- Types `setup.line` into the shell `pane` when the shell shows its prompt. It polls every SETUP_POLL_MS, for a
-- maximum of SETUP_PROMPT_MS. It does nothing when `create` typed the line already, and stops when
-- the pane is gone. When `pane` is nil, it only shows the line in a toast with `noShellReason`.
-- `done`, when set, runs once with the outcome: true once the line is typed (or `create` typed it), false
-- with the toast text when it gives up, and false with no text when the pane or the cx is gone.
local function type_setup(
	cx: WindowCx,
	pane: number?,
	noShellReason: string?,
	setup: SetupLine?,
	done: ((typed: boolean, warning: string?) -> ())?
)
	local function finish(typed: boolean, warning: string?)
		if done ~= nil then
			done(typed, warning)
		end
	end
	if setup == nil or setup.typed then
		finish(setup ~= nil, nil)
		return
	end
	local line = setup.line
	local function give_up(cx2: WindowCx, warning: string)
		cx2:toast("error", sentence_case(warning), line)
		finish(false, warning)
	end
	if pane == nil then
		give_up(cx, "setup not run: " .. (noShellReason or "no tab opened"))
		return
	end
	local deadline = tern.now() + SETUP_PROMPT_MS
	local function poll(cx2: WindowCx?)
		if cx2 == nil then
			finish(false, nil)
			return
		end
		local info = cx2.session:pane(pane)
		if info == nil then
			finish(false, nil)
			return
		end
		if info.at_prompt then
			cx2:run(pane, line .. "\r")
			finish(true, nil)
		elseif tern.now() >= deadline then
			give_up(cx2, "setup not run: no shell prompt in " .. SETUP_PROMPT_MS // 1000 .. " s")
		else
			tern.timer(SETUP_POLL_MS, poll)
		end
	end
	poll(cx)
end

-- The CLI made, reused or relocated the worktree of `res`, or gave the main checkout. Writes the entry of a worktree in
-- the worktree index, resolves the sessions, opens or focuses its tab, refreshes its repository, runs `opened`, then
-- starts to type its setup line. The index holds only worktrees in the worktree root, so the main checkout gets no
-- entry.
-- `opened`, when set, runs once with the cx that `resolve_sessions` gave. `settled`, when set, runs once when the
-- setup step ends, or at once when the tab step raises; `res.setup.typed` and `res.warnings` then hold the outcome.
-- A tab step that raises adds the warning `tab not opened: <error>`, and then no setup step runs.
local function worktree_opened(
	cx: WindowCx,
	res: CreateResult,
	opened: ((cx: WindowCx) -> ())?,
	settled: ((res: CreateResult) -> ())?
)
	local function add_warning(text: string)
		res.warnings = res.warnings or {}
		table.insert(res.warnings, text)
	end
	local function settle()
		if settled ~= nil then
			settled(res)
		end
	end
	if res.owner ~= "main" then
		set_entry(res.path, { main = res.repo, branch = res.branch, changed = 0, owner = res.owner })
	end
	resolve_sessions(cx, function(cx2)
		local ok, paneOrErr, noShellReason = pcall(open_tab, cx2, res)
		if not ok then
			add_warning("tab not opened: " .. tostring(paneOrErr))
		end
		refresh_branches(cx2, res.repo)
		if opened ~= nil then
			opened(cx2)
		end
		if not ok then
			settle()
			return
		end
		local setup = res.setup
		type_setup(cx2, paneOrErr, noShellReason, setup, function(typed, warning)
			if setup ~= nil then
				setup.typed = typed
			end
			if warning ~= nil then
				add_warning(warning)
			end
			settle()
		end)
	end)
end

-- The CLI tore down the worktree at `removed` in the repository `repo`: deletes its index entry and refreshes `repo`.
local function worktree_torn_down(cx: WindowCx, removed: string, repo: string)
	set_entry(removed, nil)
	refresh_branches(cx, repo)
end

-- Where the branch of a create is checked out before the create: nowhere (`new`), in a worktree (`worktree`) or in
-- the main checkout (`main`). It selects the progress toast only.
type Checkout = "new" | "worktree" | "main"

local function create(
	cx: WindowCx,
	root: string,
	extra: { string },
	name: string,
	checkout: Checkout,
	retry: ((cx: WindowCx) -> ())?
)
	local args = { "create", "--repo", root, "--no-tab" }
	for _, a in ipairs(extra) do
		table.insert(args, a)
	end
	if table.find(extra, "--relocate") then
		cx:toast("info", "Relocating worktree " .. name .. "…")
	elseif checkout == "main" then
		cx:toast("info", "Opening main checkout…")
	elseif checkout == "worktree" then
		cx:toast("info", "Reusing worktree " .. name .. "…")
	else
		cx:toast("info", "Creating worktree " .. name .. "…")
	end
	cli(args, function(res: CreateResult, err, cx2)
		if err ~= nil then
			if err.code == "bad_args" and retry ~= nil then
				cx2:toast("error", tostring(err.message))
				retry(cx2)
			elseif err.code == "worktree_exists_elsewhere" then
				local existing = tostring(err.existing)
				cx2:toast("info", "Worktree of " .. name .. " is outside the worktree root")
				choose(cx2, {
					placeholder = "Worktree of this branch is at " .. short_path(existing),
					items = {
						{
							id = "relocate",
							label = "Relocate to " .. short_path(tostring(err.target)),
							icon = "folder",
						},
					},
				}, function(id, cx3)
					if id == "relocate" then
						local again = table.clone(extra)
						table.insert(again, "--relocate")
						create(cx3, root, again, name, "worktree")
					end
				end)
			elseif err.code == "dirty_worktree" then
				cx2:toast("error", "Cannot relocate: uncommitted changes", dirty_summary(list_dirty_files(err)))
			else
				toast_error(cx2, err)
			end
			return
		end
		worktree_opened(cx2, res, function(cx3)
			local parts: { string } = { res.path }
			local warnings = join_or_nil(res.warnings, "; ")
			if warnings then
				table.insert(parts, warnings)
			end
			if type(res.carried) == "table" and #res.carried > 0 then
				table.insert(parts, "carried " .. #res.carried .. " ignored file(s)")
			end
			local title = if res.owner == "main"
				then "Opened main checkout"
				else sentence_case(tostring(res.status)) .. NO_BREAK_SPACE .. "worktree"
			cx3:toast("success", title, elide_start(table.concat(parts, " · "), MAX_TOAST_DETAIL))
		end)
	end)
end

local function add_row(
	root: string,
	id: string,
	title: string,
	createArgs: { string },
	name: string,
	checkout: Checkout,
	ids: { string }
)
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
			create(cx, root, createArgs, name, checkout)
		end,
	})
end

local function pr_label(pr: PullRequest): string
	return "#" .. tostring(pr.number) .. " " .. tostring(pr.title)
end

-- Where each branch of `res` with a checkout is checked out: `worktree` or `main`. A branch without one is not a key.
local function branch_checkouts(res: BranchesResult): { [string]: Checkout }
	local checkouts: { [string]: Checkout } = {}
	for _, w in ipairs(res.worktrees or {}) do
		if type(w.branch) == "string" then
			checkouts[w.branch] = if w.main == true then "main" else "worktree"
		end
	end
	return checkouts
end

-- The checkout of `branch` in `checkouts`, `new` when it has none.
local function checkout_of(checkouts: { [string]: Checkout }, branch: string): Checkout
	return checkouts[branch] or "new"
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
			refresh_branches(cx, root)
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
			refresh_branches(cx2, found)
		end
	end)
end

local repo_picker: (cx: WindowCx) -> ()

local function new_branch(cx: WindowCx, root: string, repoName: string, defaultBranch: string, typedName: string?)
	prompt_text(cx, {
		value = typedName,
		placeholder = "New branch from " .. defaultBranch .. " in " .. repoName,
		icon = "branch",
		action = "create",
	}, function(text, cx2, err)
		if err ~= nil or text == nil or text == "" then
			return
		end
		create(cx2, root, { "--branch=" .. text, "--new" }, text, "new", function(cx3)
			new_branch(cx3, root, repoName, defaultBranch, text)
		end)
	end)
end

-- The items of the branch picker for `res`: `New branch…`, `Other repo…`, the pull requests, then the branches.
local function branch_picker_items(res: BranchesResult): { PickItem }
	local checkouts = branch_checkouts(res)
	local items: { PickItem } = {
		{ id = "new", label = "New branch…", detail = "from " .. tostring(res.default), icon = "plus" },
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
			detail = if checkouts[branch] == "worktree" then "worktree" else nil,
			group = "Branches",
			icon = "branch",
		})
	end
	return items
end

-- Whether the branch picker shows the same items for `a` and `b`, in the same order: the same ids, labels, dim text
-- and groups.
local function same_branch_picker_items(a: BranchesResult, b: BranchesResult): boolean
	local itemsA, itemsB = branch_picker_items(a), branch_picker_items(b)
	if #itemsA ~= #itemsB then
		return false
	end
	for i, x in ipairs(itemsA) do
		local y = itemsB[i]
		if x.id ~= y.id or x.label ~= y.label or x.detail ~= y.detail or x.group ~= y.group then
			return false
		end
	end
	return true
end

-- Opens the picker of the branches, pull requests and worktrees of `root` in `res`.
local function show_branch_picker(cx: WindowCx, root: string, res: BranchesResult)
	local repoName = tostring(res.name)
	local defaultBranch = tostring(res.default)
	local items = branch_picker_items(res)
	local checkouts = branch_checkouts(res)
	local branchOfPr: { [string]: string } = {}
	for _, p in ipairs(res.prs or {}) do
		branchOfPr[tostring(p.number)] = tostring(p.branch)
	end
	choose(
		cx,
		{ placeholder = "Search branches in " .. repoName, icon = "branch", action = "open", items = items },
		function(id, cx2)
			if id == nil then
				return
			end
			local branch = string.match(id, "^b:(.*)$")
			local pr = string.match(id, "^pr:(.*)$")
			if id == "new" then
				new_branch(cx2, root, repoName, defaultBranch)
			elseif id == "other" then
				repo_picker(cx2)
			elseif branch ~= nil then
				create(cx2, root, { "--branch=" .. branch }, branch, checkout_of(checkouts, branch))
			elseif pr ~= nil then
				local prBranch = branchOfPr[pr] or ("#" .. pr)
				create(cx2, root, { "--pr", pr }, prBranch, checkout_of(checkouts, prBranch))
			end
		end
	)
end

-- Branches store: the `branches` answers of each repository root, which its worktree rows and its branch picker share.

type BranchesRun = { startedAt: number, online: boolean, notify: boolean }
-- The `branches` answers of one repository root. `answer` is the latest answer after `keep_last_prs`, and `online` is
-- true when `answer` holds the pull requests of an online answer. `networkAt` is the start of the last online run.
-- `run` is the run in flight, and a lost run stays there until a request replaces it. `queued` is the one run after
-- `run`. `openFor` is the press that waits for the first online answer.
type BranchesStore = {
	answer: BranchesResult?,
	online: boolean,
	networkAt: number?,
	run: BranchesRun?,
	queued: { online: boolean, notify: boolean }?,
	openFor: number?,
}
local storeOfRoot: { [string]: BranchesStore } = {}
-- The ids of the worktree rows of each repository root.
local rowsOfRoot: { [string]: { string } } = {}

-- The answer to keep after `res`: an offline answer keeps the pull requests and the default branch of `before`, and an
-- online answer with `prsFailed` keeps the pull requests of `before`.
local function keep_last_prs(before: BranchesResult?, res: BranchesResult, online: boolean): BranchesResult
	if before ~= nil and not online then
		res.prs = before.prs
		res.default = before.default
	elseif before ~= nil and res.prsFailed == true then
		res.prs = before.prs
	end
	return res
end

local function store_of(root: string): BranchesStore
	local existing = storeOfRoot[root]
	if existing ~= nil then
		return existing
	end
	local created: BranchesStore = { online = false }
	storeOfRoot[root] = created
	return created
end

-- Registers the worktree rows of `root` from `res`: one for each pull request and each branch. A row of `root` that is
-- not in `res` stops to show.
local function register_rows(root: string, res: BranchesResult)
	local name: string = if type(res.name) == "string" then res.name else basename(root)
	local prefix = "wt-" .. fnv1a(root) .. "-"
	local checkouts = branch_checkouts(res)
	local ids: { string } = {}
	for _, pr in ipairs(res.prs or {}) do
		local n = tostring(pr.number)
		local prBranch = tostring(pr.branch)
		add_row(
			root,
			prefix .. fnv1a("pr:" .. n),
			name .. ": " .. pr_label(pr),
			{ "--pr", n },
			prBranch,
			checkout_of(checkouts, prBranch),
			ids
		)
	end
	for _, branch in ipairs(res.branches or {}) do
		if type(branch) == "string" then
			local title = name .. ": " .. branch .. (if checkouts[branch] == "worktree" then " · worktree" else "")
			add_row(
				root,
				prefix .. fnv1a(branch),
				title,
				{ "--branch", branch },
				branch,
				checkout_of(checkouts, branch),
				ids
			)
		end
	end
	local currentIds: { [string]: boolean } = {}
	for _, id in ipairs(ids) do
		currentIds[id] = true
	end
	for _, id in ipairs(rowsOfRoot[root] or {}) do
		if not currentIds[id] then
			rootOfLiveRow[id] = nil
		end
	end
	rowsOfRoot[root] = ids
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

-- Whether a background trigger of `store` runs online: `git.auto_fetch_minutes` is more than 0, and at least that time
-- went by since the start of the last online run.
local function network_due(cx: WindowCx, store: BranchesStore): boolean
	local interval = fetch_interval_ms(cx)
	local networkAt = store.networkAt
	return interval > 0 and (networkAt == nil or tern.now() - networkAt >= interval)
end

-- Keeps the answer `res` of `run` in `store`, registers the worktree rows of `root` from it, opens the branch picker
-- of the press that waits for an online answer, and shows the toasts of `run`.
local function apply_branches(cx: WindowCx, root: string, store: BranchesStore, run: BranchesRun, res: BranchesResult)
	local hadOnline = store.online
	local before = store.answer
	local answer = keep_last_prs(before, res, run.online)
	store.answer = answer
	store.online = hadOnline or run.online
	register_rows(root, answer)
	local openFor = store.openFor
	if store.online and openFor ~= nil then
		store.openFor = nil
		if openFor == startCount then
			show_branch_picker(cx, root, answer)
		end
	end
	if not run.notify then
		return
	end
	if before == nil or not hadOnline then
		cx:toast("info", "Branches loaded")
	else
		cx:toast(
			"info",
			if same_branch_picker_items(before, answer)
				then "Branches refreshed: no changes"
				else "Branches refreshed: reopen to see changes"
		)
	end
end

-- Shows the toasts of the failed `run`. With no online answer in `store`, the press that waits for it stops waiting.
local function fail_branches(cx: WindowCx, store: BranchesStore, run: BranchesRun, err: any)
	if not run.notify then
		return
	end
	if store.online then
		cx:toast("error", "Branch refresh failed: " .. tostring(err.message or "tern-wt failed"))
	else
		store.openFor = nil
		toast_error(cx, err)
	end
end

-- `queued` merged with one more request: online when one of the two is online, and with toasts when one of the two
-- has toasts.
local function merge_queued(
	queued: { online: boolean, notify: boolean }?,
	online: boolean,
	notify: boolean
): { online: boolean, notify: boolean }
	return {
		online = online or (queued ~= nil and queued.online),
		notify = notify or (queued ~= nil and queued.notify),
	}
end

-- Starts a `branches` run for `root`, merged with the queued run after the run in flight, which it clears.
local function start_branches(cx: WindowCx, root: string, store: BranchesStore, online: boolean, notify: boolean)
	local merged = merge_queued(store.queued, online, notify)
	store.queued = nil
	local run: BranchesRun = { startedAt = tern.now(), online = merged.online, notify = merged.notify }
	store.run = run
	if run.online then
		store.networkAt = run.startedAt
	end
	if run.notify then
		cx:toast("info", if store.online then "Refreshing branches…" else "Loading branches…")
	end
	local args = { "branches", "--repo", root }
	if not run.online then
		table.insert(args, "--offline")
	end
	cli(args, function(res: BranchesResult, err, cx2)
		if store.run ~= run then
			return
		end
		store.run = nil
		if err == nil then
			apply_branches(cx2, root, store, run, res)
		else
			fail_branches(cx2, store, run, err)
		end
		local queued = store.queued
		if queued ~= nil then
			start_branches(cx2, root, store, queued.online, queued.notify)
		end
	end)
end

-- Requests a `branches` run for `root`: online with `online`, and with toasts with `notify`. The rules:
-- I0. Only a press asks for toasts, and a press is online: `notify` is true only with `online`.
-- I1. At most one run of each root is in flight. A run is in flight until it answers, or for the timeout of `cli`
--     (120 s). A run with no answer after that time is lost.
-- I2. A request while a run is in flight starts no run. It sets the one run after it: online when one of the requests
--     is online, and with toasts when one of the requests asks for toasts that the run in flight does not show.
--     I3 is the exception.
-- I3. A press while the store has no online answer joins an online run in flight and sets no run after it. When that
--     run has no toasts, it gets them, and `Loading branches…` shows at once.
-- I4. A run starts merged with the run after the run in flight, which it clears. An online run sets `networkAt`. A run
--     with toasts shows `Refreshing branches…` when the store has an online answer, else `Loading branches…`. The run
--     goes into the store before `cli` starts it.
-- I5. The answer of a run that a request replaced is ignored. A successful answer goes through `keep_last_prs` into the
--     store and opens the branch picker of the press that waits for an online answer. With toasts it shows
--     `Branches loaded` for the first online answer, else a toast that tells if the picker items changed. A failed
--     answer keeps the store answer. With toasts it shows `Branch refresh failed: <cause>` when the store has an online
--     answer, else the error, and the waiting press stops. Then the run after it starts.
-- I6. The worktree rows register from each successful answer, of each run.
local function request_branches(cx: WindowCx, root: string, online: boolean, notify: boolean)
	local store = store_of(root)
	local run = store.run
	if run == nil or not in_flight(run.startedAt) then
		start_branches(cx, root, store, online, notify)
	elseif notify and not store.online and run.online then
		if not run.notify then
			run.notify = true
			cx:toast("info", "Loading branches…")
		end
	else
		store.queued = merge_queued(store.queued, online, notify and not run.notify)
	end
end

-- A background trigger of `root`: a `branches` run with no toasts, online when `git.auto_fetch_minutes` is due.
refresh_branches = function(cx: WindowCx, root: string)
	request_branches(cx, root, network_due(cx, store_of(root)), false)
end

-- Opens the branch picker of `root`. With an online answer in the store it shows that answer at once. Else the press
-- waits for the next online answer, which opens the picker when this press is the latest press. Then it requests an
-- online `branches` with toasts, for this open or the next one.
local function branch_picker(cx: WindowCx, root: string)
	local store = store_of(root)
	local answer = store.answer
	if store.online and answer ~= nil then
		store.openFor = nil
		show_branch_picker(cx, root, answer)
	else
		store.openFor = startCount
	end
	request_branches(cx, root, true, true)
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
		}, function(id)
			local nameWithOwner = if id ~= nil then string.match(id, "^gh:(.*)$") else nil
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
	}, function(id)
		if id ~= nil then
			make_repo(owner, name, id)
		end
	end)
end

local function ask_name(cx: WindowCx, owner: string)
	prompt_text(cx, {
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
		function(id, ownerCx)
			if id ~= nil then
				ask_name(ownerCx, id)
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
		function(id, cx2)
			if id == nil then
				return
			end
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

local function deleted_title(res: RemoveResult): string
	local title = "Deleted" .. NO_BREAK_SPACE .. "worktree"
	if type(res.branch) ~= "string" then
		return title
	end
	if res.branchDeleted then
		return title .. " and branch"
	end
	if res.branchKept == "not_merged" then
		return title .. ", kept branch: not merged"
	end
	return title .. ", kept branch"
end

-- The detail line of the Deleted worktree toast: the head of each warning of `res`, without the first warning when
-- `branchKept` is `not_merged`.
local function short_warnings(res: RemoveResult): string?
	local parts: { string } = {}
	local warnings = res.warnings or {}
	for i = if res.branchKept == "not_merged" then 2 else 1, #warnings do
		local w = warnings[i]
		table.insert(parts, string.match(w, "^(.-): ") or w)
	end
	return if #parts > 0 then table.concat(parts, "; ") else nil
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
	local entry = worktreeIndex[path]
	local name = if entry ~= nil and entry.branch ~= nil then entry.branch else basename(path)
	cx:toast("info", "Deleting worktree " .. name .. "…")
	cli(args, function(res: RemoveResult, err, cx2)
		if err ~= nil then
			local title = "Teardown failed: " .. failure_message(err, path)
			cx2:toast("error", title)
			choose(cx2, {
				placeholder = title,
				icon = "branch",
				items = {
					{ id = "retry", label = "Retry", icon = "repeat" },
					{ id = "force", label = "Force delete", detail = "discards uncommitted work", icon = "trash" },
				},
			}, function(id, cx3)
				if id == "retry" then
					run_remove(cx3, path, false, done, stop)
				elseif id == "force" then
					run_remove(cx3, path, true, done, stop)
				else
					stop(cx3)
				end
			end)
			return
		end
		cx2:toast("success", deleted_title(res), short_warnings(res))
		worktree_torn_down(cx2, res.removed, res.repo)
		done(cx2)
	end)
end

local function confirm_teardown(cx: WindowCx, tab: number?, paths: { string }, index: number, teardownDetail: string?)
	local path = paths[index]
	if path == nil then
		if tab ~= nil then
			close_tab(cx, tab)
		end
		return
	end
	local function advance(cx2: WindowCx)
		confirm_teardown(cx2, tab, paths, index + 1, teardownDetail)
	end
	local function stop(cx2: WindowCx)
		if tab == nil then
			advance(cx2)
		end
	end
	local function mark_handled_then_next(cx2: WindowCx)
		if tab ~= nil then
			handled[path] = true
		end
		advance(cx2)
	end
	local placeholderPrefix = if tab ~= nil then "Closing worktree tab · " else "Worktree tab closed · "
	local keepDetail = if tab ~= nil then "closes the tab, keeps the worktree" else "keeps the worktree"
	-- `choose` already toasts a pick error. A pick error counts as Keep, so the tab closes even when the picker fails.
	choose(cx, {
		placeholder = placeholderPrefix .. short_path(path),
		icon = "branch",
		items = {
			{ id = "keep", label = "Keep worktree", detail = keepDetail, icon = "folder" },
			{
				id = "teardown",
				label = "Tear down",
				detail = teardownDetail,
				icon = "trash",
			},
		},
	}, function(id, cx2, pickErr)
		if id == "teardown" then
			run_remove(cx2, path, false, mark_handled_then_next, stop)
		elseif pickErr ~= nil or id == "keep" then
			mark_handled_then_next(cx2)
		else
			stop(cx2)
		end
	end)
end

-- Opens the teardown picker for `paths` with the teardown policy from `tern-wt config` as the detail of the Tear down
-- item. When `config` fails, the item has no detail line.
local function ask_teardown(cx: WindowCx, tab: number?, paths: { string })
	cli({ "config" }, function(res: ConfigResult, err, cx2)
		confirm_teardown(cx2, tab, paths, 1, if err == nil then POLICY[res.teardown] else nil)
	end)
end

local function intercept(cx: WindowCx, tab: number?): boolean
	if tab == nil then
		return false
	end
	local paths: { string } = {}
	for _, path in ipairs(tab_paths(cx, tab)) do
		if tern.fs.exists(path) and not pane_under(cx, path, tab) then
			table.insert(paths, path)
		end
	end
	if #paths == 0 then
		return false
	end
	ask_teardown(cx, tab, paths)
	return true
end

tern.command({
	id = "new",
	title = "New worktree tab",
	icon = "branch",
	keys = new_tab_keys(),
	run = start,
})

-- The worktree segment shows the branch and the number of changed files of the worktree of the focused pane. It
-- reads only the worktree index. Tern disables a formatter that takes more than 4 ms, and `tern.chrome.refresh`
-- raises an error when a formatter calls it.
tern.chrome.status(function(pane: StatusPaneInfo): { StatusSegment }?
	local _, entry = index_lookup(pane.cwd)
	if entry == nil then
		return nil
	end
	local branch = entry.branch or "detached"
	return {
		{
			text = if entry.changed > 0 then branch .. " · " .. entry.changed else branch,
			icon = "branch",
			tone = if entry.changed > 0 then "warn" else "muted",
			command = "plugin.tern-worktrees.new",
		},
	}
end)

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

-- Tern has no install hook, so each load of the window half runs `tern-wt setup`: a window start, a reload, and an
-- install into an open window. A timer starts it after the load. It links `tern-wt` and the skill to the copy of the
-- plugin that Tern loaded, and tells the user only when a link changed or setup failed.
local function link_cli_and_skill()
	cli({ "setup" }, function(res: SetupResult, err, cx)
		if err ~= nil then
			cx:toast("error", "Setup failed: " .. tostring(err.message or "tern-wt failed"))
			return
		end
		for _, link in ipairs(res.links or {}) do
			if link.action ~= "kept" then
				cx:toast("info", "Linked tern-wt and the tern-worktrees skill")
				return
			end
		end
	end)
end

tern.timer(0, link_cli_and_skill)

tern.on("window_start", function(cx: WindowCx)
	rebuild_managed(cx)
	for _, pane in ipairs(cx.session:panes()) do
		remember_cwd(pane.pane, pane.cwd)
	end
	resolve_sessions(cx, function(cx2)
		for _, repo in ipairs(localRepos) do
			refresh_branches(cx2, repo.root)
		end
	end)
	list_all(function(res, _cx2)
		local learned = if res ~= nil and type(res.root) == "string" then without_trailing_slash(res.root) else nil
		if learned ~= nil and learned ~= "" and learned ~= ROOT then
			ROOT = learned
			pcall(tern.kv.set, ROOT_KEY, learned)
		end
	end)
end)

for _, name in ipairs({ "tab_created", "pane_created" }) do
	tern.on(name, function(_ev: any, cx: WindowCx)
		rebuild_managed(cx)
		local root = ROOT
		if root == nil then
			return
		end
		for _, pane in ipairs(cx.session:panes()) do
			if is_under(pane.cwd, root) and index_lookup(pane.cwd) == nil then
				refresh_index()
				return
			end
		end
	end)
end

tern.on("cwd", function(ev: CwdEvent, cx: WindowCx)
	rebuild_managed(cx)
	remember_cwd(ev.pane, ev.path)
	if ev.pane == cx.session:focused() then
		refresh_dir(cx, ev.path)
	end
	local root = ROOT
	if root ~= nil and is_under(ev.path, root) and index_lookup(ev.path) == nil then
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
		if index_lookup(pane.cwd) ~= nil then
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
	if index_lookup(cwd) ~= nil then
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
		ask_teardown(cx, nil, open)
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
	sig = "(repo: string, branch: string, new: boolean?) -> {branch: string, carried: {string}, owner: string, path: string, repo: string, setup: {line: string, typed: boolean}?, status: string, warnings: {string}}",
	doc = "Create or reuse a worktree for branch in repo (a dir inside the repo) and open it as a tab. When the main checkout holds branch, it opens the main checkout where it is, with owner main. For a new worktree, setup is the line of setup commands of its repository: the reply comes once the tab's shell prompt shows and the line is typed (typed true), or once that is given up after at most 30 s (typed false, with a setup not run warning).",
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
		worktree_opened(cx2, res, nil, function(settledRes)
			call:reply(settledRes)
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
			worktree_torn_down(cx2, res.removed, res.repo)
		end
		reply_to(call)(res, err, cx2)
	end)
	return call:wait(120000)
end)
