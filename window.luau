--!strict

local CLI = tern.plugin.dir .. "/bin/tern-wt"
local DIALOG = "tern-worktrees.dialog"
local ROOT = (tern.getenv("TERN_WT_HOME") or ((tern.getenv("HOME") or "") .. "/.tern-wt")) .. "/worktrees"
local DEFAULT_KEYS = { "ctrl+b>w" }
local DEFAULT_TEARDOWN = "worktree+merged-branch"
local POLICY = {
	worktree = "remove worktree, keep branch",
	["worktree+merged-branch"] = "remove worktree, delete branch if merged",
	["worktree+branch"] = "remove worktree and branch",
}

type Answer = { [string]: any }
type AnswerCb = (answer: Answer, cx: WindowCx) -> ()
type CliCb = (result: any, err: any, cx: WindowCx) -> ()
type Config = { hotkeys: { new: { string } }, teardown: string }
type Repo = { root: string, name: string }

local pending: { [number]: { reqid: string, cb: AnswerCb } } = {}
local counter = 0
local managed: { [number]: string } = {}
local handled: { [string]: boolean } = {}
local rootOfSession: { [number]: string } = {}
local localRepos: { Repo } = {}
local queuedErrors: { string } = {}
local configWarned = false

local function flush(cx: WindowCx)
	for _, text in ipairs(queuedErrors) do
		cx:toast("error", text)
	end
	table.clear(queuedErrors)
end

local function cli(args: { string }, cb: CliCb)
	tern.process.run({ CLI, table.unpack(args) }, { timeout_ms = 120000 }, function(r: ProcessResult, cx: WindowCx?)
		if cx == nil then
			return
		end
		local ok, decoded = pcall(tern.json.decode, r.stdout)
		if not ok or type(decoded) ~= "table" then
			cb(nil, { code = "cli_failed", message = if r.stderr ~= "" then r.stderr else "tern-wt failed" }, cx)
		elseif r.status ~= 0 then
			cb(nil, decoded.error or { code = "cli_failed", message = r.stderr }, cx)
		else
			cb(decoded, nil, cx)
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
		if not configWarned then
			configWarned = true
			table.insert(queuedErrors, "tern-worktrees: invalid config.json, using defaults")
		end
		return defaults
	end
	local keys = if type(decoded.hotkeys) == "table" then decoded.hotkeys.new else nil
	return {
		hotkeys = { new = if type(keys) == "table" then keys else DEFAULT_KEYS },
		teardown = if type(decoded.teardown) == "string" then decoded.teardown else DEFAULT_TEARDOWN,
	}
end

local function join_or_nil(list: any, sep: string): string?
	if type(list) ~= "table" or #list == 0 then
		return nil
	end
	return table.concat(list, sep)
end

local function session_of_tab(cx: WindowCx, tab: number?): number?
	if tab == nil then
		return nil
	end
	for _, s in ipairs(cx.session:sessions()) do
		if table.find(s.tabs, tab) ~= nil then
			return s.id
		end
	end
	return nil
end

local function current_session(cx: WindowCx): SessionInfo?
	for _, s in ipairs(cx.session:sessions()) do
		if s.current then
			return s
		end
	end
	return nil
end

local function session_exists(cx: WindowCx, id: number): boolean
	for _, s in ipairs(cx.session:sessions()) do
		if s.id == id then
			return true
		end
	end
	return false
end

local function tab_path(cx: WindowCx, tab: number): string?
	for _, pane in ipairs(cx.session:panes()) do
		if pane.tab == tab then
			local path = managed_path(pane.cwd)
			if path ~= nil then
				return path
			end
		end
	end
	return nil
end

local function panes_of_tab(cx: WindowCx, tab: number): { number }
	local ids: { number } = {}
	for _, pane in ipairs(cx.session:panes()) do
		if pane.tab == tab then
			table.insert(ids, pane.pane)
		end
	end
	return ids
end

local function close_tab_panes(cx: WindowCx, tab: number)
	for _, id in ipairs(panes_of_tab(cx, tab)) do
		cx.layout:close(id)
	end
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
	local seen: { [number]: boolean } = {}
	local found: { [number]: string } = {}
	for _, pane in ipairs(cx.session:panes()) do
		local tab = pane.tab
		if tab ~= nil then
			seen[tab] = true
			if found[tab] == nil then
				local path = managed_path(pane.cwd)
				if path ~= nil then
					found[tab] = path
				end
			end
		end
	end
	for tab in pairs(seen) do
		managed[tab] = found[tab]
	end
end

local function ask(cx: WindowCx, req: { [string]: any }, cb: AnswerCb)
	counter += 1
	local reqid = tostring(tern.now()) .. "-" .. tostring(counter)
	local pane = cx:new_block(DIALOG, { reqid, tern.json.encode(req) }, "beside", { focus = false })
	if pane == nil then
		cx:toast("error", "Worktree dialog unavailable")
		return
	end
	cx.layout:float(pane)
	cx.layout:focus(pane)
	pending[pane] = { reqid = reqid, cb = cb }
end

local function confirm(cx: WindowCx, title: string, message: string, buttons: { any }, cb: AnswerCb)
	ask(cx, { mode = "confirm", title = title, message = message, buttons = tern.json.array(buttons) }, cb)
end

local function pick(cx: WindowCx, req: { [string]: any }, cb: AnswerCb)
	req.mode = "pick"
	req.items = tern.json.array(req.items)
	ask(cx, req, cb)
end

local function toast_error(cx: WindowCx, err: any)
	cx:toast("error", tostring(err and err.message or "tern-wt failed"))
end

local function resolve_sessions(cx: WindowCx, cb: (cx: WindowCx) -> ())
	local cwds: { string } = {}
	local seen: { [string]: boolean } = {}
	for _, pane in ipairs(cx.session:panes()) do
		local cwd = pane.cwd
		if cwd ~= nil and cwd ~= "" and not seen[cwd] then
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
	cli(cwds, function(res, err, cx2)
		if err ~= nil then
			toast_error(cx2, err)
			cb(cx2)
			return
		end
		local rootOfDir: { [string]: string } = {}
		table.clear(localRepos)
		local listedRoots: { [string]: boolean } = {}
		for _, r in ipairs(res.repos or {}) do
			if type(r.root) == "string" then
				rootOfDir[r.dir] = r.root
				if not listedRoots[r.root] then
					listedRoots[r.root] = true
					table.insert(localRepos, { root = r.root, name = r.name or basename(r.root) })
				end
			end
		end
		table.clear(rootOfSession)
		for _, pane in ipairs(cx2.session:panes()) do
			local sid = session_of_tab(cx2, pane.tab)
			local root = pane.cwd and rootOfDir[pane.cwd]
			if sid ~= nil and root ~= nil and rootOfSession[sid] == nil then
				rootOfSession[sid] = root
			end
		end
		cb(cx2)
	end)
end

local function open_tab(cx: WindowCx, res: any)
	local path: string = res.path
	local tab: number? = nil
	for _, pane in ipairs(cx.session:panes()) do
		if is_under(pane.cwd, path) and not pending[pane.pane] then
			local sid = session_of_tab(cx, pane.tab)
			local cur = current_session(cx)
			if sid ~= nil and cur ~= nil and sid ~= cur.id then
				cx.sessions:switch(sid)
			end
			cx.layout:focus(pane.pane)
			tab = pane.tab
			break
		end
	end
	if tab == nil then
		local sid: number? = nil
		for id, root in pairs(rootOfSession) do
			if root == res.repo and session_exists(cx, id) then
				sid = id
				break
			end
		end
		if sid ~= nil then
			local cur = current_session(cx)
			if cur == nil or cur.id ~= sid then
				cx.sessions:switch(sid)
			end
			local pane = cx.layout:new_tab({ cwd = path })
			tab = if pane ~= nil then cx.session:tab_of(pane) else nil
		else
			local newSession = cx.sessions:create({ name = basename(res.repo), cwd = path })
			rootOfSession[newSession.id] = res.repo
			for _, info in ipairs(cx.session:sessions()) do
				if info.id == newSession.id then
					tab = info.tabs[1]
				end
			end
		end
		if tab ~= nil then
			cx.layout:name_tab(tab, res.branch)
		end
	end
	if tab ~= nil then
		managed[tab] = path
	end
end

local function create(cx: WindowCx, root: string, extra: { string })
	local args = { "create", "--repo", root, "--no-tab" }
	for _, a in ipairs(extra) do
		table.insert(args, a)
	end
	cli(args, function(res, err, cx2)
		if err ~= nil then
			if err.code == "worktree_exists_elsewhere" then
				confirm(
					cx2,
					"Branch has a worktree elsewhere",
					tostring(err.existing) .. "\nRelocate it to " .. tostring(err.target) .. "?",
					{ { id = "relocate", label = "Relocate", kind = "primary" }, { id = "cancel", label = "Cancel" } },
					function(a, cx3)
						if a.action == "button" and a.id == "relocate" then
							local again = table.clone(extra)
							table.insert(again, "--relocate")
							create(cx3, root, again)
						end
					end
				)
			elseif err.code == "dirty_worktree" then
				local files: { string } = {}
				for i, f in ipairs(err.files or {}) do
					if i > 5 then
						break
					end
					table.insert(files, f)
				end
				cx2:toast("error", "Cannot relocate: uncommitted changes", table.concat(files, ", "))
			elseif err.code == "branch_in_main_checkout" then
				cx2:toast("error", "Branch is checked out in the main checkout", err.existing)
			else
				toast_error(cx2, err)
			end
			return
		end
		open_tab(cx2, res)
		local warnings = join_or_nil(res.warnings, "; ")
		cx2:toast(
			"success",
			tostring(res.status) .. " " .. tostring(res.branch),
			res.path .. (if warnings then " · " .. warnings else "")
		)
	end)
end

local repo_picker: (cx: WindowCx) -> ()

local function branch_picker(cx: WindowCx, root: string)
	cli({ "branches", "--repo", root }, function(res, err, cx2)
		if err ~= nil then
			toast_error(cx2, err)
			return
		end
		local wt: { [string]: string } = {}
		for _, w in ipairs(res.worktrees or {}) do
			if type(w.branch) == "string" then
				wt[w.branch] = w.path
			end
		end
		local items: { any } = { { id = "other", label = "Other repo…" } }
		for _, pr in ipairs(res.prs or {}) do
			table.insert(items, {
				id = "pr:" .. tostring(pr.number),
				label = "#" .. tostring(pr.number) .. " " .. tostring(pr.title),
				detail = pr.branch,
				group = "Pull requests",
			})
		end
		for _, name in ipairs(res.branches or {}) do
			local path = wt[name]
			table.insert(items, {
				id = "b:" .. name,
				label = name,
				detail = if path then path .. " · worktree" else nil,
				group = "Branches",
			})
		end
		pick(cx2, {
			title = tostring(res.name) .. ": choose branch",
			items = items,
			allowNew = true,
			newLabel = "Create branch “%s” from " .. tostring(res.default),
		}, function(a, cx3)
			if a.action == "new" and type(a.text) == "string" and a.text ~= "" then
				create(cx3, root, { "--branch", a.text, "--new" })
			elseif a.action == "select" and type(a.id) == "string" then
				local id: string = a.id
				if id == "other" then
					repo_picker(cx3)
				elseif string.sub(id, 1, 2) == "b:" then
					create(cx3, root, { "--branch", string.sub(id, 3) })
				elseif string.sub(id, 1, 3) == "pr:" then
					create(cx3, root, { "--pr", string.sub(id, 4) })
				end
			end
		end)
	end)
end

local function github_picker(cx: WindowCx)
	cx:toast("info", "Loading GitHub repos…")
	cli({ "repos" }, function(res, err, cx2)
		if err ~= nil then
			toast_error(cx2, err)
			return
		end
		local items: { any } = {}
		for _, r in ipairs(res.repos or {}) do
			local nwo: string = r.nameWithOwner
			table.insert(items, {
				id = "gh:" .. nwo,
				label = nwo,
				detail = if type(r.description) == "string" and r.description ~= "" then r.description else nil,
				group = string.match(nwo, "^([^/]+)/") or nwo,
			})
		end
		pick(cx2, { title = "Choose GitHub repository", items = items }, function(a, cx3)
			if a.action ~= "select" or type(a.id) ~= "string" or string.sub(a.id, 1, 3) ~= "gh:" then
				return
			end
			cli({ "clone", string.sub(a.id, 4) }, function(cloned, cerr, cx4)
				if cerr ~= nil then
					toast_error(cx4, cerr)
					return
				end
				branch_picker(cx4, cloned.root)
			end)
		end)
	end)
end

local function new_repo(cx: WindowCx)
	cli({ "repos" }, function(res, err, cx2)
		if err ~= nil then
			toast_error(cx2, err)
			return
		end
		local owners: { any } = {}
		for _, o in ipairs(res.owners or {}) do
			table.insert(owners, { id = o, label = o })
		end
		pick(cx2, { title = "Repository owner", items = owners }, function(a, cx3)
			if a.action ~= "select" or type(a.id) ~= "string" then
				return
			end
			local owner: string = a.id
			ask(cx3, { mode = "prompt", title = "Repository name", placeholder = "name" }, function(t, cx4)
				if t.action ~= "text" or type(t.text) ~= "string" or t.text == "" then
					return
				end
				local name: string = t.text
				pick(cx4, {
					title = "Visibility of " .. owner .. "/" .. name,
					items = { { id = "private", label = "private" }, { id = "public", label = "public" } },
				}, function(v, cx5)
					if v.action ~= "select" or type(v.id) ~= "string" then
						return
					end
					cli({ "new-repo", owner .. "/" .. name, "--visibility", v.id }, function(made, merr, cx6)
						if merr ~= nil then
							toast_error(cx6, merr)
							return
						end
						branch_picker(cx6, made.root)
					end)
				end)
			end)
		end)
	end)
end

repo_picker = function(cx: WindowCx)
	local items: { any } = {}
	for _, r in ipairs(localRepos) do
		table.insert(items, { id = "local:" .. r.root, label = r.name, detail = r.root, group = "Open sessions" })
	end
	table.insert(items, { id = "github", label = "Browse GitHub repos…" })
	table.insert(items, { id = "newrepo", label = "Create new GitHub repo…" })
	pick(cx, { title = "Choose repository", items = items }, function(a, cx2)
		if a.action ~= "select" or type(a.id) ~= "string" then
			return
		end
		local id: string = a.id
		if string.sub(id, 1, 6) == "local:" then
			branch_picker(cx2, string.sub(id, 7))
		elseif id == "github" then
			github_picker(cx2)
		elseif id == "newrepo" then
			new_repo(cx2)
		end
	end)
end

local function start(cx: WindowCx)
	flush(cx)
	resolve_sessions(cx, function(cx2)
		local cur = current_session(cx2)
		local root = if cur ~= nil then rootOfSession[cur.id] else nil
		if root ~= nil then
			branch_picker(cx2, root)
		else
			repo_picker(cx2)
		end
	end)
end

local function run_remove(cx: WindowCx, tab: number?, path: string, force: boolean)
	local args = { "remove", path, "--keep-tab" }
	if force then
		table.insert(args, "--force")
	end
	cli(args, function(res, err, cx2)
		if err ~= nil then
			confirm(cx2, "Teardown failed", tostring(err.message), {
				{ id = "retry", label = "Retry", kind = "primary" },
				{ id = "force", label = "Force delete", kind = "danger" },
				{ id = "cancel", label = "Cancel" },
			}, function(a, cx3)
				if a.action == "button" and a.id == "retry" then
					run_remove(cx3, tab, path, false)
				elseif a.action == "button" and a.id == "force" then
					run_remove(cx3, tab, path, true)
				end
			end)
			return
		end
		if tab ~= nil and #panes_of_tab(cx2, tab) > 0 then
			handled[path] = true
			close_tab_panes(cx2, tab)
		end
		cx2:toast("success", "Removed " .. tostring(res.branch or path), join_or_nil(res.warnings, "; "))
	end)
end

local function confirm_teardown(cx: WindowCx, tab: number?, path: string, tabOpen: boolean)
	local policy = config().teardown
	local buttons: { any } = {
		{ id = "teardown", label = "Tear down", kind = "danger" },
		{ id = "keep", label = "Keep worktree" },
	}
	if tabOpen then
		table.insert(buttons, { id = "cancel", label = "Cancel" })
	end
	confirm(cx, "Tear down worktree?", path .. "\nPolicy: " .. (POLICY[policy] or policy), buttons, function(a, cx2)
		if a.action ~= "button" then
			return
		end
		if a.id == "teardown" then
			run_remove(cx2, tab, path, false)
		elseif a.id == "keep" and tab ~= nil then
			handled[path] = true
			close_tab_panes(cx2, tab)
		end
	end)
end

local function intercept(cx: WindowCx, tab: number?): boolean
	if tab == nil then
		return false
	end
	local path = tab_path(cx, tab)
	if path == nil or pane_under(cx, path, tab) then
		return false
	end
	confirm_teardown(cx, tab, path, true)
	return true
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
	return intercept(cx, if focused ~= nil then cx.session:tab_of(focused) else nil)
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
end)

for _, name in ipairs({ "tab_created", "pane_created", "cwd" }) do
	tern.on(name, function(_ev: any, cx: WindowCx)
		rebuild_managed(cx)
	end)
end

tern.on("title", function(ev: TitleEvent, cx: WindowCx)
	local entry = pending[ev.pane]
	if entry == nil then
		return
	end
	local prefix = "twt:" .. entry.reqid .. ":"
	if string.sub(ev.title, 1, #prefix) ~= prefix then
		return
	end
	local ok, decoded = pcall(tern.json.decode, string.sub(ev.title, #prefix + 1))
	local answer: Answer = if ok and type(decoded) == "table" then decoded else { action = "cancel" }
	pending[ev.pane] = nil
	cx.layout:close(ev.pane)
	entry.cb(answer, cx)
end)

tern.on("pane_closed", function(ev: PaneEvent, cx: WindowCx)
	local entry = pending[ev.pane]
	if entry == nil then
		return
	end
	pending[ev.pane] = nil
	entry.cb({ action = "cancel" }, cx)
end)

tern.on("tab_closed", function(ev: TabEvent, cx: WindowCx)
	flush(cx)
	local path = managed[ev.tab]
	managed[ev.tab] = nil
	if path == nil then
		return
	end
	if not handled[path] and tern.fs.exists(path) and not pane_under(cx, path, nil) then
		confirm_teardown(cx, nil, path, false)
	end
	handled[path] = nil
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
	cli(argv, function(res, err, cx2)
		if err ~= nil then
			call:fail(err_text(err))
			return
		end
		resolve_sessions(cx2, function(cx3)
			local ok, why = pcall(function()
				open_tab(cx3, res)
			end)
			if not ok then
				res.warnings = res.warnings or {}
				table.insert(res.warnings, "tab not opened: " .. tostring(why))
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
	cli({ "list" }, function(res, err, _cx2)
		if err ~= nil then
			call:fail(err_text(err))
		else
			call:reply(res)
		end
	end)
	return call:wait(120000)
end)

tern.carly.export("remove", {
	sig = "(path: string, force: boolean?) -> {removed: string}",
	doc = "Tear down the managed worktree at path under the teardown policy and close its tabs; force discards uncommitted work.",
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
	cli(argv, function(res, err, _cx2)
		if err ~= nil then
			call:fail(err_text(err))
		else
			call:reply(res)
		end
	end)
	return call:wait(120000)
end)
