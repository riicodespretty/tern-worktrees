--!strict

local CLI = tern.plugin.dir .. "/bin/tern-wt"
local DIALOG = "tern-worktrees.dialog"
local FLOAT_SHEET = "dialog-float"

local floatOk, floatSource = pcall(tern.fs.read, tern.plugin.dir .. "/dialog-float.css")
local floatRules: string? = if floatOk then floatSource else nil
tern.css(FLOAT_SHEET, "")

local function env(name: string): string?
	local value = tern.getenv(name)
	return if value == "" then nil else value
end

local function initial_root(): string
	local home = env("TERN_WT_HOME") or ((env("HOME") or "") .. "/.tern-wt")
	return (string.gsub(home, "/+$", "")) .. "/worktrees"
end

local ROOT = initial_root()
local DEFAULT_KEYS = { "ctrl+b>w" }
local DEFAULT_TEARDOWN = "worktree+merged-branch"
local POLICY = {
	worktree = "Removes the worktree and keeps the branch.",
	["worktree+merged-branch"] = "Removes the worktree, and deletes the branch if it is merged.",
	["worktree+branch"] = "Removes the worktree and deletes the branch.",
}

-- NOTE: The dialog protocol constants and the Item and Button types below must match the block at the top of host.luau. Change both files together.
local TITLE_PREFIX = "twt:"
local MODE_PICK: "pick" = "pick"
local MODE_CONFIRM: "confirm" = "confirm"
local MODE_PROMPT: "prompt" = "prompt"
local ACTION_SELECT: "select" = "select"
local ACTION_NEW: "new" = "new"
local ACTION_BUTTON: "button" = "button"
local ACTION_TEXT: "text" = "text"
local ACTION_CANCEL: "cancel" = "cancel"
local KIND_CANCEL: "cancel" = "cancel"

type Answer =
	{ action: typeof(ACTION_CANCEL) }
	| { action: typeof(ACTION_BUTTON), id: string }
	| { action: typeof(ACTION_SELECT), id: string }
	| { action: typeof(ACTION_NEW), text: string }
	| { action: typeof(ACTION_TEXT), text: string }
type AnswerCb = (answer: Answer, cx: WindowCx) -> ()
type CliCb<T> = (result: T, err: any, cx: WindowCx) -> ()
type Item = { id: string, label: string, detail: string?, group: string?, icon: string? }
type Button = { id: string, label: string, kind: ("primary" | "danger" | typeof(KIND_CANCEL))? }
type PickOptions = {
	title: string,
	items: { Item },
	allowNew: boolean?,
	newLabel: string?,
	placeholder: string?,
	verb: string?,
}
type ConfirmOptions = {
	title: string,
	path: string,
	message: string,
	listing: { string }?,
	buttons: { Button },
	reveal: boolean?,
}
type PickDialog = PickOptions & { mode: typeof(MODE_PICK) }
type ConfirmDialog = ConfirmOptions & { mode: typeof(MODE_CONFIRM) }
type PromptDialog = {
	mode: typeof(MODE_PROMPT),
	title: string,
	placeholder: string?,
	verb: string?,
}
type DialogRequest = PickDialog | ConfirmDialog | PromptDialog
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
type RemoveResult = { branch: string?, warnings: { string } }
type ListResult = { root: string, worktrees: { any } }
type RootResult = { root: string }
type Pending = { reqid: string, cb: AnswerCb }
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

local pending: { [number]: Pending } = {}
local counter = 0
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

local function managed_path(cwd: string?): string?
	if cwd == nil or string.sub(cwd, 1, #ROOT + 1) ~= ROOT .. "/" then
		return nil
	end
	local repo, slug = string.match(string.sub(cwd, #ROOT + 2), "^([^/]+)/([^/]+)")
	if repo == nil or slug == nil then
		return nil
	end
	return ROOT .. "/" .. repo .. "/" .. slug
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
		if pane.tab == tab and not pending[pane.pane] then
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
		if pane.tab == tab and not pending[pane.pane] then
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
		if pane.tab ~= exceptTab and is_under(pane.cwd, path) then
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

local function end_wait(pane: number)
	pending[pane] = nil
	if next(pending) == nil then
		tern.css(FLOAT_SHEET, "")
	end
end

local function begin_wait(pane: number, entry: Pending)
	if next(pending) == nil and floatRules ~= nil then
		tern.css(FLOAT_SHEET, floatRules)
	end
	pending[pane] = entry
end

local function focus_flow_dialog(cx: WindowCx): boolean
	local index = session_index(cx)
	local current = index.current
	if current == nil then
		return false
	end
	for pane in pairs(pending) do
		if session_of_tab(index, cx.session:tab_of(pane)) == current.id then
			cx.layout:focus(pane)
			return true
		end
	end
	return false
end

local function parse_answer(decoded: any): Answer
	if type(decoded) ~= "table" then
		return { action = ACTION_CANCEL }
	end
	local action, id, text = decoded.action, decoded.id, decoded.text
	if action == ACTION_BUTTON and type(id) == "string" then
		return { action = ACTION_BUTTON, id = id }
	elseif action == ACTION_SELECT and type(id) == "string" then
		return { action = ACTION_SELECT, id = id }
	elseif action == ACTION_NEW and type(text) == "string" then
		return { action = ACTION_NEW, text = text }
	elseif action == ACTION_TEXT and type(text) == "string" then
		return { action = ACTION_TEXT, text = text }
	end
	return { action = ACTION_CANCEL }
end

local function ask(cx: WindowCx, req: DialogRequest, cb: AnswerCb, reveal: boolean?): boolean
	counter += 1
	local reqid = tostring(tern.now()) .. "-" .. tostring(counter)
	local pane = cx:new_block(DIALOG, { reqid, tern.json.encode(req) }, "beside", { focus = false })
	if pane == nil then
		cx:toast("error", "Worktree dialog unavailable")
		return false
	end
	if reveal == false then
		cx.layout:float(pane, nil, nil, { focus = false })
	else
		cx.layout:float(pane)
		cx.layout:focus(pane)
	end
	begin_wait(pane, { reqid = reqid, cb = cb })
	return true
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

local function confirm(cx: WindowCx, req: ConfirmOptions, cb: AnswerCb): boolean
	local dialog = table.clone(req) :: ConfirmDialog
	dialog.mode = MODE_CONFIRM
	dialog.reveal = nil
	local listing = req.listing
	dialog.listing = if listing ~= nil and #listing > 0 then tern.json.array(listing) else nil
	dialog.buttons = tern.json.array(req.buttons)
	return ask(cx, dialog, cb, req.reveal)
end

local function pick(cx: WindowCx, req: PickOptions, cb: AnswerCb)
	local dialog = table.clone(req) :: PickDialog
	dialog.mode = MODE_PICK
	dialog.items = tern.json.array(req.items)
	ask(cx, dialog, cb)
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

local function dirty_lines(shown: DirtyListing): { string }
	local listing: { string } = table.clone(shown.changes)
	if #shown.ignored > 0 then
		table.insert(listing, "Ignored files that are hard to rebuild:")
		table.move(shown.ignored, 1, #shown.ignored, #listing + 1, listing)
	end
	if shown.omitted > 0 then
		table.insert(listing, "and " .. shown.omitted .. " more")
	end
	return listing
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

local function failure_message(err: any, path: string): (string, { string })
	local lines: { string } = {}
	local listing = if err.code == "dirty_worktree" then dirty_lines(list_dirty_files(err.files)) else {}
	if #listing > 0 then
		table.insert(lines, "Removing this worktree loses these changes:")
	else
		table.insert(lines, replace_plain(tostring(err.message), path, short_path(path)))
	end
	local saved = staging_line(err)
	if saved ~= nil then
		table.insert(lines, replace_plain(saved, path, short_path(path)))
	end
	return table.concat(lines, "\n"), listing
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
		table.clear(rootOfSession)
		local index = session_index(cx2)
		for _, pane in ipairs(cx2.session:panes()) do
			local sid = session_of_tab(index, pane.tab)
			local root = pane.cwd and rootOfDir[pane.cwd]
			if sid ~= nil and type(root) == "string" and rootOfSession[sid] == nil then
				rootOfSession[sid] = root
			end
		end
		cb(cx2)
	end)
end

local function open_tab(cx: WindowCx, res: CreateResult)
	local path = res.path
	local tab: number? = nil
	local index = session_index(cx)
	for _, pane in ipairs(cx.session:panes()) do
		if is_under(pane.cwd, path) and not pending[pane.pane] then
			local sid = session_of_tab(index, pane.tab)
			if sid ~= nil then
				switch_to_session_if_current_known(cx, index, sid)
			end
			cx.layout:focus(pane.pane)
			tab = pane.tab
			break
		end
	end
	if tab == nil then
		local sid: number? = nil
		for id, root in pairs(rootOfSession) do
			if root == res.repo and index.byId[id] ~= nil then
				sid = id
				break
			end
		end
		if sid ~= nil then
			switch_to_session(cx, index, sid)
			local pane = cx.layout:new_tab({ cwd = path })
			tab = if pane ~= nil then cx.session:tab_of(pane) else nil
		else
			local newSession = cx.sessions:create({ name = basename(res.repo), cwd = path })
			rootOfSession[newSession.id] = res.repo
			local created = session_index(cx).byId[newSession.id]
			if created ~= nil then
				tab = created.tabs[1]
			end
		end
		if tab ~= nil then
			cx.layout:name_tab(tab, res.branch)
		end
	end
	if tab ~= nil then
		local paths = managed[tab] or {}
		managed[tab] = paths
		if table.find(paths, path) == nil then
			table.insert(paths, path)
		end
	end
end

local function create(cx: WindowCx, root: string, extra: { string })
	local args = { "create", "--repo", root, "--no-tab" }
	for _, a in ipairs(extra) do
		table.insert(args, a)
	end
	cli(args, function(res: CreateResult, err, cx2)
		if err ~= nil then
			if err.code == "worktree_exists_elsewhere" then
				confirm(cx2, {
					title = "Branch has a worktree elsewhere",
					path = short_path(tostring(err.existing)),
					message = "Relocate it to " .. short_path(tostring(err.target)) .. "?",
					buttons = {
						{ id = "relocate", label = "Relocate", kind = "primary" },
						{ id = "cancel", label = "Cancel", kind = KIND_CANCEL },
					},
				}, function(answer, cx3)
					if answer.action == ACTION_BUTTON and answer.id == "relocate" then
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
		cx2:toast("success", tostring(res.status) .. " worktree", table.concat(parts, " · "))
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

local function branch_picker(cx: WindowCx, root: string)
	local started = startCount
	cli_or_toast({ "branches", "--repo", root }, function(res: BranchesResult, cx2)
		if startCount ~= started then
			return
		end
		local hasWorktree = branches_with_worktree(res)
		local items: { Item } = { { id = "other", label = "Other repo…", icon = "folder" } }
		for _, pr in ipairs(res.prs or {}) do
			table.insert(items, {
				id = "pr:" .. tostring(pr.number),
				label = pr_label(pr),
				detail = pr.branch,
				group = "Pull requests",
				icon = "merge",
			})
		end
		for _, name in ipairs(res.branches or {}) do
			table.insert(items, {
				id = "b:" .. name,
				label = name,
				detail = if hasWorktree[name] then "worktree" else nil,
				group = "Branches",
				icon = "branch",
			})
		end
		pick(cx2, {
			title = tostring(res.name) .. ": choose branch",
			placeholder = "Search branches in " .. tostring(res.name),
			items = items,
			allowNew = true,
			newLabel = "Create branch “%s” from " .. tostring(res.default),
		}, function(answer, cx3)
			if answer.action == ACTION_NEW and answer.text ~= "" then
				create(cx3, root, { "--branch", answer.text, "--new" })
			elseif answer.action == ACTION_SELECT then
				local id = answer.id
				local branch = string.match(id, "^b:(.*)$")
				local pr = string.match(id, "^pr:(.*)$")
				if id == "other" then
					repo_picker(cx3)
				elseif branch ~= nil then
					create(cx3, root, { "--branch", branch })
				elseif pr ~= nil then
					create(cx3, root, { "--pr", pr })
				end
			end
		end)
	end)
end

local function github_picker(cx: WindowCx)
	cx:toast("info", "Loading GitHub repos…")
	cli_or_toast({ "repos" }, function(res: ReposResult, reposCx)
		local items: { Item } = {}
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
		pick(reposCx, {
			title = "Choose GitHub repository",
			placeholder = "Search GitHub repositories",
			verb = "clone",
			items = items,
		}, function(answer)
			local nameWithOwner = if answer.action == ACTION_SELECT then string.match(answer.id, "^gh:(.*)$") else nil
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
	pick(cx, {
		title = "Visibility of " .. owner .. "/" .. name,
		placeholder = "Choose visibility of " .. owner .. "/" .. name,
		verb = "create",
		items = {
			{ id = "private", label = "private", icon = "lock" },
			{ id = "public", label = "public", icon = "globe" },
		},
	}, function(answer)
		if answer.action == ACTION_SELECT then
			make_repo(owner, name, answer.id)
		end
	end)
end

local function ask_name(cx: WindowCx, owner: string)
	ask(cx, {
		mode = MODE_PROMPT,
		title = "Repository name",
		placeholder = "Name of the new repository under " .. owner,
		verb = "continue",
	}, function(answer, nameCx)
		if answer.action == ACTION_TEXT and answer.text ~= "" then
			ask_visibility(nameCx, owner, answer.text)
		end
	end)
end

local function ask_owner(cx: WindowCx, ownerNames: { string })
	local owners: { Item } = {}
	for _, o in ipairs(ownerNames) do
		table.insert(owners, { id = o, label = o, icon = "user" })
	end
	pick(
		cx,
		{ title = "Repository owner", placeholder = "Search owners", verb = "choose", items = owners },
		function(answer, ownerCx)
			if answer.action == ACTION_SELECT then
				ask_name(ownerCx, answer.id)
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
	local items: { Item } = {}
	for _, r in ipairs(localRepos) do
		table.insert(items, {
			id = "local:" .. r.root,
			label = r.name,
			detail = short_path(r.root),
			group = "Open sessions",
			icon = "folder",
		})
	end
	table.insert(items, { id = "github", label = "Browse GitHub repos…", icon = "globe" })
	table.insert(items, { id = "newrepo", label = "Create new GitHub repo…", icon = "folder-plus" })
	pick(cx, { title = "Choose repository", placeholder = "Search repositories", items = items }, function(answer, cx2)
		local id = if answer.action == ACTION_SELECT then answer.id else nil
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
	end)
end

local function start(cx: WindowCx)
	if focus_flow_dialog(cx) then
		return
	end
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
			local message, listing = failure_message(err, path)
			confirm(cx2, {
				title = "Teardown failed",
				path = short_path(path),
				message = message,
				listing = listing,
				buttons = {
					{ id = "retry", label = "Retry", kind = "primary" },
					{ id = "force", label = "Force delete", kind = "danger" },
					{ id = "cancel", label = "Cancel", kind = KIND_CANCEL },
				},
			}, function(answer, cx3)
				if answer.action == ACTION_BUTTON and answer.id == "retry" then
					run_remove(cx3, path, false, done, stop)
				elseif answer.action == ACTION_BUTTON and answer.id == "force" then
					run_remove(cx3, path, true, done, stop)
				else
					stop(cx3)
				end
			end)
			return
		end
		cx2:toast("success", "Removed " .. tostring(res.branch or path), join_or_nil(res.warnings, "; "))
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
	local policy = config().teardown
	local teardown: Button = { id = "teardown", label = "Tear down", kind = "danger" }
	local keep: Button = { id = "keep", label = "Keep worktree" }
	local buttons: { Button } = if tab ~= nil
		then { teardown, keep, { id = "cancel", label = "Cancel", kind = KIND_CANCEL } }
		else { keep, teardown }
	return confirm(cx, {
		title = "Tear down worktree?",
		path = short_path(path),
		message = POLICY[policy] or ("Policy: " .. policy),
		buttons = buttons,
		reveal = tab ~= nil,
	}, function(answer, cx2)
		if answer.action == ACTION_BUTTON and answer.id == "teardown" then
			run_remove(cx2, path, false, function(cx3)
				if tab ~= nil then
					handled[path] = true
				end
				advance(cx3)
			end, stop)
		elseif answer.action == ACTION_BUTTON and answer.id == "keep" then
			if tab ~= nil then
				handled[path] = true
			end
			advance(cx2)
		else
			stop(cx2)
		end
	end)
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
	if focused == nil or pending[focused] then
		return false
	end
	return intercept(cx, cx.session:tab_of(focused))
end)

tern.override("close_pane", function(cx: WindowCx): boolean?
	local focused = cx.session:focused()
	if focused == nil or pending[focused] then
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
	cli({ "list" }, function(res: RootResult, err, cx2)
		if err == nil and type(res.root) == "string" and res.root ~= ROOT then
			ROOT = res.root
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
end)

tern.on("focus", function(ev: FocusEvent, cx: WindowCx)
	local pane = cx.session:pane(ev.pane)
	if pane ~= nil then
		remember_cwd(ev.pane, pane.cwd)
		if ev.pane == cx.session:focused() then
			refresh_dir(cx, pane.cwd)
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
end)

tern.on("title", function(ev: TitleEvent, cx: WindowCx)
	local entry = pending[ev.pane]
	if entry == nil then
		return
	end
	local prefix = TITLE_PREFIX .. entry.reqid .. ":"
	if string.sub(ev.title, 1, #prefix) ~= prefix then
		return
	end
	local ok, decoded = pcall(tern.json.decode, string.sub(ev.title, #prefix + 1))
	local answer = parse_answer(if ok then decoded else nil)
	end_wait(ev.pane)
	cx.layout:close(ev.pane)
	entry.cb(answer, cx)
end)

tern.on("pane_closed", function(ev: PaneEvent, cx: WindowCx)
	cwdOfPane[ev.pane] = nil
	local entry = pending[ev.pane]
	if entry == nil then
		return
	end
	end_wait(ev.pane)
	entry.cb({ action = ACTION_CANCEL }, cx)
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
			after_change(cx2)
		end
		reply_to(call)(res, err, cx2)
	end)
	return call:wait(120000)
end)
