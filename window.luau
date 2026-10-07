--!strict

local CLI = tern.plugin.dir .. "/bin/tern-wt"
local DIALOG = "tern-worktrees.dialog"

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
local managed: { [number]: { string } } = {}
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
	local sid = session_of_tab(cx, tab)
	local cur = current_session(cx)
	if sid ~= nil and cur ~= nil and sid ~= cur.id then
		cx.sessions:switch(sid)
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

local function ask(cx: WindowCx, req: { [string]: any }, cb: AnswerCb, reveal: boolean?): boolean
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
	pending[pane] = { reqid = reqid, cb = cb }
	return true
end

local function confirm(
	cx: WindowCx,
	title: string,
	message: string,
	buttons: { any },
	cb: AnswerCb,
	reveal: boolean?
): boolean
	return ask(
		cx,
		{ mode = "confirm", title = title, message = message, buttons = tern.json.array(buttons) },
		cb,
		reveal
	)
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
	cli(args, function(res, err, cx2)
		if err ~= nil then
			if err.code == "worktree_exists_elsewhere" then
				confirm(
					cx2,
					"Branch has a worktree elsewhere",
					tostring(err.existing) .. "\nRelocate it to " .. tostring(err.target) .. "?",
					{ { id = "relocate", label = "Relocate", kind = "primary" }, { id = "cancel", label = "Cancel" } },
					function(answer, cx3)
						if answer.action == "button" and answer.id == "relocate" then
							local again = table.clone(extra)
							table.insert(again, "--relocate")
							create(cx3, root, again)
						end
					end
				)
			elseif err.code == "dirty_worktree" then
				local files: { string } = table.move(err.files or {}, 1, 5, 1, {})
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
		local worktreeOfBranch: { [string]: string } = {}
		for _, w in ipairs(res.worktrees or {}) do
			if type(w.branch) == "string" then
				worktreeOfBranch[w.branch] = w.path
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
			local path = worktreeOfBranch[name]
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
		}, function(answer, cx3)
			if answer.action == "new" and type(answer.text) == "string" and answer.text ~= "" then
				create(cx3, root, { "--branch", answer.text, "--new" })
			elseif answer.action == "select" and type(answer.id) == "string" then
				local id: string = answer.id
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
	cli({ "repos" }, function(res, err, cx2)
		if err ~= nil then
			toast_error(cx2, err)
			return
		end
		local items: { any } = {}
		for _, r in ipairs(res.repos or {}) do
			local nameWithOwner: string = r.nameWithOwner
			table.insert(items, {
				id = "gh:" .. nameWithOwner,
				label = nameWithOwner,
				detail = if type(r.description) == "string" and r.description ~= "" then r.description else nil,
				group = string.match(nameWithOwner, "^([^/]+)/") or nameWithOwner,
			})
		end
		pick(cx2, { title = "Choose GitHub repository", items = items }, function(answer, cx3)
			local nameWithOwner = if answer.action == "select" and type(answer.id) == "string"
				then string.match(answer.id, "^gh:(.*)$")
				else nil
			if nameWithOwner == nil then
				return
			end
			cli({ "clone", nameWithOwner }, function(clone, cloneErr, cx4)
				if cloneErr ~= nil then
					toast_error(cx4, cloneErr)
					return
				end
				branch_picker(cx4, clone.root)
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
		pick(cx2, { title = "Repository owner", items = owners }, function(ownerAnswer, cx3)
			if ownerAnswer.action ~= "select" or type(ownerAnswer.id) ~= "string" then
				return
			end
			local owner: string = ownerAnswer.id
			ask(cx3, { mode = "prompt", title = "Repository name", placeholder = "name" }, function(nameAnswer, cx4)
				if nameAnswer.action ~= "text" or type(nameAnswer.text) ~= "string" or nameAnswer.text == "" then
					return
				end
				local name: string = nameAnswer.text
				pick(cx4, {
					title = "Visibility of " .. owner .. "/" .. name,
					items = { { id = "private", label = "private" }, { id = "public", label = "public" } },
				}, function(visibilityAnswer, cx5)
					if visibilityAnswer.action ~= "select" or type(visibilityAnswer.id) ~= "string" then
						return
					end
					cli(
						{ "new-repo", owner .. "/" .. name, "--visibility", visibilityAnswer.id },
						function(newRepo, newRepoErr, cx6)
							if newRepoErr ~= nil then
								toast_error(cx6, newRepoErr)
								return
							end
							branch_picker(cx6, newRepo.root)
						end
					)
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
	pick(cx, { title = "Choose repository", items = items }, function(answer, cx2)
		if answer.action ~= "select" or type(answer.id) ~= "string" then
			return
		end
		local id: string = answer.id
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
	cli(args, function(res, err, cx2)
		if err ~= nil then
			confirm(cx2, "Teardown failed", tostring(err.message), {
				{ id = "retry", label = "Retry", kind = "primary" },
				{ id = "force", label = "Force delete", kind = "danger" },
				{ id = "cancel", label = "Cancel" },
			}, function(answer, cx3)
				if answer.action == "button" and answer.id == "retry" then
					run_remove(cx3, path, false, done, stop)
				elseif answer.action == "button" and answer.id == "force" then
					run_remove(cx3, path, true, done, stop)
				else
					stop(cx3)
				end
			end)
			return
		end
		cx2:toast("success", "Removed " .. tostring(res.branch or path), join_or_nil(res.warnings, "; "))
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
	local teardown = { id = "teardown", label = "Tear down", kind = "danger" }
	local keep = { id = "keep", label = "Keep worktree" }
	local buttons: { any } = if tab ~= nil
		then { teardown, keep, { id = "cancel", label = "Cancel" } }
		else { keep, teardown }
	return confirm(
		cx,
		"Tear down worktree?",
		path .. "\nPolicy: " .. (POLICY[policy] or policy),
		buttons,
		function(answer, cx2)
			if answer.action == "button" and answer.id == "teardown" then
				run_remove(cx2, path, false, function(cx3)
					if tab ~= nil then
						handled[path] = true
					end
					advance(cx3)
				end, stop)
			elseif answer.action == "button" and answer.id == "keep" then
				if tab ~= nil then
					handled[path] = true
				end
				advance(cx2)
			else
				stop(cx2)
			end
		end,
		tab ~= nil
	)
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
	cli({ "list" }, function(res, err, cx2)
		if err == nil and type(res.root) == "string" and res.root ~= ROOT then
			ROOT = res.root
			table.clear(managed)
			rebuild_managed(cx2)
		end
	end)
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

local function reply_to(call: any): CliCb
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
	cli(argv, function(res, err, cx2)
		if err ~= nil then
			call:fail(err_text(err))
			return
		end
		resolve_sessions(cx2, function(cx3)
			local ok, openErr = pcall(function()
				open_tab(cx3, res)
			end)
			if not ok then
				res.warnings = res.warnings or {}
				table.insert(res.warnings, "tab not opened: " .. tostring(openErr))
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
	cli({ "list" }, reply_to(call))
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
	cli(argv, reply_to(call))
	return call:wait(120000)
end)
