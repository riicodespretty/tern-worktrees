--!strict
-- A fake `tern` and a fake WindowCx, so that lune can run a plugin file.

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local serde = require("@lune/serde")

local PLUGIN_DIR = "/plugin"
local DATA_DIR = "/plugin-data"

export type Pane = { pane: number, tab: number?, cwd: string?, parked: boolean?, at_prompt: boolean?, session: number? }
export type Fail = { new_tab: boolean?, unpark: boolean?, move_to_new_tab: boolean?, focus: boolean?, create: boolean? }
export type SessionRecord = { id: number, name: string?, tabs: { number }? }
export type CxOptions = { sessions: { SessionRecord }?, current: number?, fail: Fail? }
export type Run = { argv: { string }, cb: (result: any, cx: any) -> () }
export type Timer = { at: number, fn: (cx: any) -> (), cancelled: boolean }
export type Call = {
	replies: { any },
	reply: (self: Call, res: any) -> (),
	fail: (self: Call, err: string) -> (),
	wait: (self: Call, ms: number) -> any,
}
export type Options = {
	file: string?,
	env: { [string]: string }?,
	files: { [string]: string }?,
	kv: { [string]: any }?,
	cx: any?,
}
export type Harness = {
	commands: { [string]: any },
	overrides: { [string]: (cx: any) -> any },
	handlers: { [string]: (...any) -> () },
	exports: { [string]: (...any) -> ...any },
	runs: { Run },
	kv: { [string]: any },
	clock: number,
	timers: { Timer },
	-- The `tern.chrome.status` formatter, and how many times `tern.chrome.refresh` ran.
	formatter: ((pane: any) -> any)?,
	refreshes: number,
	answer: (self: Harness, verb: string, stdout: string, status: number?, cx: any?) -> (),
	tick: (self: Harness, ms: number) -> (),
	pending: (self: Harness, verb: string) -> { string },
	status: (self: Harness, cwd: string?) -> any,
}

local Stub = {}

local lastCx: any = nil

type Record = { id: number, name: string, tabs: { number } }

-- Returns a fake WindowCx for the panes in `panes`. Each `pick` and `prompt` request goes into `cx.asked`. A
-- request keeps its options in `opts` and its `:next` callback in `next`. To answer a request, the test calls
-- `next` with `(result, err, cx)`. Each `cx:run(pane, text)` goes into `cx.typed`.
--
-- The fake window keeps its state over `panes`, which holds the panes and their tabs:
-- - `cx.records`: the sessions from `opts.sessions` (default one session `{ id = 1, name = "main" }`), each with its
--   tab ids in order. A tab that no record holds is in the session of its first pane: `pane.session`, else the
--   first record. A parked pane has no tab.
-- - `cx.current` (default `opts.current`, else the first record) and `cx.focused` (default `focused`).
-- - `cx.names[tab]`: the name that `layout:name_tab` gave the tab.
-- - `cx.effects`: one line for each effect, in order. `cx.on_effect`, when set, runs with each line once it is in
--   the log.
-- - `cx.fail`: the effects that fail, from `opts.fail`.
-- A new pane, tab or session gets the highest id in use plus 1.
function Stub.cx(panes: { Pane }, focused: number?, opts: CxOptions?): any
	local asked: { any } = {}
	local options: CxOptions = opts or {}
	local records: { Record } = {}
	local given: { SessionRecord } = options.sessions or { { id = 1, name = "main" } }
	for _, s in given do
		table.insert(records, { id = s.id, name = s.name or `session {s.id}`, tabs = table.clone(s.tabs or {}) })
	end
	local cx: any

	local function ask(request: any): any
		table.insert(asked, request)
		return {
			kind = request.kind,
			id = #asked,
			next = function(_self: any, fn: (result: any, err: string?, cx: any) -> ())
				request.next = fn
			end,
		}
	end

	local function find(id: number): Pane?
		for _, p in panes do
			if p.pane == id then
				return p
			end
		end
		return nil
	end

	local function record_by_id(id: number): Record?
		for _, r in records do
			if r.id == id then
				return r
			end
		end
		return nil
	end

	local function record_of_tab(tab: number): Record?
		for _, r in records do
			if table.find(r.tabs, tab) ~= nil then
				return r
			end
		end
		return nil
	end

	local function session_of(p: Pane): number
		local record = if p.tab ~= nil then record_of_tab(p.tab) else nil
		if record ~= nil then
			return record.id
		end
		return p.session or records[1].id
	end

	local function has_pane(tab: number): boolean
		for _, p in panes do
			if p.tab == tab and not p.parked then
				return true
			end
		end
		return false
	end

	local function tabs_of(id: number): { number }
		local ids: { number } = {}
		local record = record_by_id(id)
		local recorded: { number } = if record ~= nil then record.tabs else {}
		for _, tab in recorded do
			if has_pane(tab) and table.find(ids, tab) == nil then
				table.insert(ids, tab)
			end
		end
		for _, p in panes do
			local tab = p.tab
			if tab ~= nil and not p.parked and session_of(p) == id and table.find(ids, tab) == nil then
				table.insert(ids, tab)
			end
		end
		return ids
	end

	local function tab_ids(): { number }
		local ids: { number } = {}
		for _, p in panes do
			if p.tab ~= nil and table.find(ids, p.tab) == nil then
				table.insert(ids, p.tab)
			end
		end
		return ids
	end

	local function next_pane(): number
		local highest = 0
		for _, p in panes do
			highest = math.max(highest, p.pane)
		end
		return highest + 1
	end

	local function next_tab(): number
		local highest = 0
		for _, p in panes do
			highest = math.max(highest, p.tab or 0)
		end
		for _, r in records do
			for _, tab in r.tabs do
				highest = math.max(highest, tab)
			end
		end
		return highest + 1
	end

	local function next_session(): number
		local highest = 0
		for _, r in records do
			highest = math.max(highest, r.id)
		end
		return highest + 1
	end

	local function effect(line: string)
		table.insert(cx.effects, line)
		if cx.on_effect ~= nil then
			cx.on_effect(line)
		end
	end

	-- Adds a shell pane at `cwd` in a new last tab of session `id`, and focuses it. Returns the tab and the pane.
	local function open_shell(id: number, cwd: string?): (number, number)
		local tab, pane = next_tab(), next_pane()
		local record = record_by_id(id)
		assert(record ~= nil, `no session {id}`)
		table.insert(record.tabs, tab)
		table.insert(panes, { pane = pane, tab = tab, cwd = cwd, at_prompt = false, session = id })
		cx.focused = pane
		return tab, pane
	end

	cx = {
		asked = asked,
		toasts = {},
		typed = {},
		commands = {},
		records = records,
		current = options.current or records[1].id,
		focused = focused,
		names = {},
		effects = {},
		on_effect = nil,
		fail = options.fail or {},
		session = {
			panes = function(_self: any): { Pane }
				return panes
			end,
			focused = function(_self: any): number?
				return cx.focused
			end,
			tab_of = function(_self: any, id: number): number?
				local p = find(id)
				return if p ~= nil then p.tab else nil
			end,
			tabs = function(_self: any): { any }
				local tabs: { any } = {}
				for _, id in tab_ids() do
					local paneCount = 0
					for _, p in panes do
						if p.tab == id then
							paneCount += 1
						end
					end
					table.insert(tabs, { id = id, panes = paneCount })
				end
				return tabs
			end,
			sessions = function(_self: any): { any }
				local list: { any } = {}
				for _, r in records do
					table.insert(
						list,
						{ id = r.id, name = r.name, current = r.id == cx.current, locked = false, tabs = tabs_of(r.id) }
					)
				end
				return list
			end,
			pane = function(_self: any, id: number): Pane?
				return find(id)
			end,
		},
		layout = {
			-- Focuses `pane`. It does not switch the session [unverified]. With `fail.focus`, the focus stays.
			focus = function(_self: any, pane: number)
				if cx.fail.focus then
					effect(`focus {pane} failed`)
					return
				end
				cx.focused = pane
				effect(`focus {pane}`)
			end,
			-- Removes `pane`. A tab with no pane closes.
			close = function(_self: any, pane: number)
				local p = find(pane)
				if p ~= nil then
					table.remove(panes, table.find(panes, p))
				end
				if cx.focused == pane then
					cx.focused = nil
				end
				effect(`close {pane}`)
			end,
			-- Opens a shell at `launch.cwd` in a new last tab of the current session, and focuses it.
			new_tab = function(_self: any, launch: any): number?
				if cx.fail.new_tab then
					effect("new_tab failed")
					return nil
				end
				local tab, pane = open_shell(cx.current, if launch ~= nil then launch.cwd else nil)
				effect(`new_tab → tab {tab}, pane {pane}`)
				return pane
			end,
			-- Deals the parked `pane` into the tab of the focused pane, which must be a tab of the current session
			-- [unverified], and focuses it.
			unpark = function(_self: any, pane: number): (boolean, string?)
				local p = find(pane)
				local target = if cx.focused ~= nil then find(cx.focused) else nil
				local tab = if target ~= nil and not target.parked then target.tab else nil
				if cx.fail.unpark or p == nil or not p.parked or target == nil or tab == nil then
					effect(`unpark {pane} failed`)
					return false, "cannot unpark"
				end
				if session_of(target) ~= cx.current then
					effect(`unpark {pane} failed`)
					return false, "no tab in the current session"
				end
				p.parked = false
				p.tab = tab
				p.session = cx.current
				cx.focused = pane
				effect(`unpark {pane} → tab {tab}`)
				return true, nil
			end,
			-- Moves the pane, which must not be parked [unverified], to a new last tab of `session`, else of its own
			-- session.
			move_to_new_tab = function(_self: any, pane: number, session: number?): (number?, string?)
				local p = find(pane)
				local id = if session ~= nil then session elseif p ~= nil then session_of(p) else nil
				local record = if id ~= nil then record_by_id(id) else nil
				if cx.fail.move_to_new_tab or p == nil or p.parked or record == nil then
					effect(`move_to_new_tab {pane} {session} failed`)
					return nil, "cannot move"
				end
				local tab = next_tab()
				table.insert(record.tabs, tab)
				p.tab = tab
				p.session = record.id
				effect(`move_to_new_tab {pane} {session} → tab {tab}`)
				return tab, nil
			end,
			-- Parks `pane`: it leaves its tab and stays in its session. A tab with no pane closes.
			park = function(_self: any, pane: number): (boolean, string?)
				local p = find(pane)
				if p == nil or p.parked then
					effect(`park {pane} failed`)
					return false, "cannot park"
				end
				p.session = session_of(p)
				p.parked = true
				p.tab = nil
				if cx.focused == pane then
					cx.focused = nil
				end
				effect(`park {pane}`)
				return true, nil
			end,
			name_tab = function(_self: any, tab: number, name: string)
				cx.names[tab] = name
				effect(`name_tab {tab} {name}`)
			end,
		},
		sessions = {
			-- Makes `id` the current session. When the focused pane is not in it, the focus goes to the first pane of
			-- its first tab [unverified].
			switch = function(_self: any, id: number)
				assert(record_by_id(id) ~= nil, `no session {id}`)
				cx.current = id
				local p = if cx.focused ~= nil then find(cx.focused) else nil
				if p == nil or p.parked or session_of(p) ~= id then
					cx.focused = nil
					local first = tabs_of(id)[1]
					for _, q in panes do
						if first ~= nil and q.tab == first and not q.parked then
							cx.focused = q.pane
							break
						end
					end
				end
				effect(`switch {id}`)
			end,
			-- Makes a session named `opts.name` with one shell at `opts.cwd`, and switches to it. With `fail.create`, the
			-- session has no tab.
			create = function(_self: any, launch: any): any
				local id = next_session()
				local name = if launch ~= nil and launch.name ~= nil then launch.name else `session {id}`
				table.insert(records, { id = id, name = name, tabs = {} })
				cx.current = id
				if cx.fail.create then
					cx.focused = nil
					effect(`create_session {id} {name} → no tab`)
					return { id = id, name = name, host = 0, current = true, locked = false, tabs = 0 }
				end
				local tab, pane = open_shell(id, if launch ~= nil then launch.cwd else nil)
				effect(`create_session {id} {name} → tab {tab}, pane {pane}`)
				return { id = id, name = name, host = 0, current = true, locked = false, tabs = 1 }
			end,
		},
	}

	function cx.toast(self: any, level: string, title: string, detail: string?)
		table.insert(self.toasts, { level = level, title = title, detail = detail })
	end

	function cx.command(self: any, id: string)
		table.insert(self.commands, id)
	end

	function cx.run(self: any, pane: number, text: string)
		table.insert(self.typed, { pane = pane, text = text })
	end

	function cx.pick(_self: any, request: any): any
		return ask({ kind = "pick", opts = request })
	end

	function cx.prompt(_self: any, request: any): any
		return ask({ kind = "prompt", opts = request })
	end

	lastCx = cx
	return cx
end

-- A fake Carly call. `reply` appends its result to `replies`, `fail` raises "call:fail <err>", and `wait` returns nil.
function Stub.call(): Call
	local call: Call = {
		replies = {},
		reply = function(self: Call, res: any)
			table.insert(self.replies, res)
		end,
		fail = function(_self: Call, err: string)
			error("call:fail " .. err, 0)
		end,
		wait = function(_self: Call, _ms: number): any
			return nil
		end,
	}
	return call
end

-- The item of the pick `request` with `id`. It raises when no item has that id.
function Stub.item(request: any, id: string): any
	for _, it in request.opts.items do
		if it.id == id then
			return it
		end
	end
	error("no item " .. id, 0)
end

local function answer(self: Harness, verb: string, stdout: string, status: number?, cx: any?)
	local matching: { Run } = {}
	for i = #self.runs, 1, -1 do
		if self.runs[i].argv[2] == verb then
			table.insert(matching, 1, table.remove(self.runs, i) :: Run)
		end
	end
	for _, run in matching do
		run.cb({ stdout = stdout, stderr = "", status = status or 0 }, cx)
	end
end

-- Loads and runs `opts.file` (default `window.luau`) in a new environment with a fake `tern`. Returns the
-- commands, overrides, handlers and exports that the file registered, with the fake CLI runs, kv, clock and timers.
function Stub.load(opts: Options): Harness
	local env: { [string]: string } = opts.env or {}
	local files: { [string]: string } = opts.files or {}
	local defaultCx = opts.cx
	local formatting = false
	local loaded: Harness = {
		commands = {},
		overrides = {},
		handlers = {},
		exports = {},
		runs = {},
		kv = opts.kv or {},
		clock = 0,
		timers = {},
		refreshes = 0,
		answer = function(self: Harness, verb: string, stdout: string, status: number?, cx: any?)
			answer(self, verb, stdout, status, cx or defaultCx or lastCx)
		end,
		-- Moves the fake clock by `ms`. Each timer due in that time fires at its own time, earliest first, also one
		-- that a callback set.
		tick = function(self: Harness, ms: number)
			local target = self.clock + ms
			while true do
				local dueIndex: number? = nil
				for i, timer in self.timers do
					if timer.at <= target and (dueIndex == nil or timer.at < self.timers[dueIndex].at) then
						dueIndex = i
					end
				end
				if dueIndex == nil then
					self.clock = target
					return
				end
				local timer = table.remove(self.timers, dueIndex) :: Timer
				self.clock = math.max(self.clock, timer.at)
				if not timer.cancelled then
					timer.fn(defaultCx or lastCx)
				end
			end
		end,
		-- The arguments after the binary of each run of `verb` that no answer has taken yet, in order.
		pending = function(self: Harness, verb: string): { string }
			local lines: { string } = {}
			for _, run in self.runs do
				if run.argv[2] == verb then
					table.insert(lines, table.concat(run.argv, " ", 2))
				end
			end
			return lines
		end,
		-- Runs the status formatter for a focused pane in `cwd`. `tern.chrome.refresh` raises an error while the
		-- formatter runs, as it does in Tern.
		status = function(self: Harness, cwd: string?): any
			local formatter = self.formatter
			assert(formatter ~= nil, "no status formatter registered")
			formatting = true
			local ok, result = pcall(formatter, { pane = 1, cwd = cwd, program = "zsh", busy = false })
			formatting = false
			if not ok then
				error(result, 0)
			end
			return result
		end,
	}

	local fakeTern = {
		plugin = { dir = PLUGIN_DIR, data = DATA_DIR },
		fs = {
			read = function(path: string, _max: number?): string
				local text = files[path]
				if text == nil then
					error("no such file: " .. path, 2)
				end
				return text
			end,
			exists = function(path: string): boolean
				if files[path] ~= nil then
					return true
				end
				for name in files do
					if string.sub(name, 1, #path + 1) == path .. "/" then
						return true
					end
				end
				return false
			end,
		},
		getenv = function(name: string): string?
			return env[name]
		end,
		kv = {
			get = function(key: string): any
				return loaded.kv[key]
			end,
			-- Stores a JSON copy, as Tern's kv.json does, so windows that share `kv` never share a table.
			set = function(key: string, value: any)
				loaded.kv[key] = if value == nil then nil else serde.decode("json", serde.encode("json", value))
			end,
		},
		command = function(spec: any)
			loaded.commands[spec.id] = spec
		end,
		override = function(name: string, fn: (cx: any) -> any)
			loaded.overrides[name] = fn
		end,
		on = function(name: string, fn: (...any) -> ())
			loaded.handlers[name] = fn
		end,
		carly = {
			export = function(name: string, _meta: any, fn: (...any) -> ...any)
				loaded.exports[name] = fn
			end,
		},
		process = {
			run = function(argv: { string }, _opts: any, cb: (result: any, cx: any) -> ())
				table.insert(loaded.runs, { argv = argv, cb = cb })
			end,
		},
		json = {
			encode = function(value: any): string
				return serde.encode("json", value)
			end,
			decode = function(text: string): any
				return serde.decode("json", text)
			end,
			array = function(list: { any }): { any }
				return list
			end,
		},
		now = function(): number
			return loaded.clock
		end,
		timer = function(ms: number, fn: (cx: any) -> ()): any
			local timer: Timer = { at = loaded.clock + ms, fn = fn, cancelled = false }
			table.insert(loaded.timers, timer)
			return {
				cancel = function(_self: any)
					timer.cancelled = true
				end,
			}
		end,
		chrome = {
			status = function(fn: (pane: any) -> any)
				loaded.formatter = fn
			end,
			refresh = function()
				if formatting then
					error("tern.chrome.refresh called from a formatter", 2)
				end
				loaded.refreshes += 1
			end,
		},
	}

	local file = opts.file or "window.luau"
	local environment: { [string]: any } = setmetatable({ tern = fakeTern }, { __index = _G }) :: any
	luau.load(fs.readFile(file), { debugName = file, environment = environment })()
	return loaded
end

-- The fixture test/fixtures/contract/<name>.json as JSON text, with each `{{key}}` replaced by `vars[key]`.
-- It raises when a placeholder has no value. Paths are relative to the repository root, where `vp run test:luau` runs.
function Stub.fixture(name: string, vars: { [string]: string }): string
	local text = fs.readFile("test/fixtures/contract/" .. name .. ".json")
	return (
		string.gsub(text, "{{([%w_]+)}}", function(key: string): string
			local value = vars[key]
			if value == nil then
				error(name .. ".json: no value for {{" .. key .. "}}", 0)
			end
			return value
		end)
	)
end

-- The fixture `name` with `vars` as in `Stub.fixture`, with each top-level key of `fields` set to its value, as JSON
-- text.
function Stub.answer(name: string, vars: { [string]: string }, fields: { [string]: any }?): string
	local res = serde.decode("json", Stub.fixture(name, vars))
	local extra: { [string]: any } = fields or {}
	for key, value in extra do
		res[key] = value
	end
	return serde.encode("json", res)
end

return Stub
