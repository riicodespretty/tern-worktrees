--!strict
-- A fake `tern` and a fake WindowCx, so that lune can run a plugin file.

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local serde = require("@lune/serde")

local PLUGIN_DIR = "/plugin"
local DATA_DIR = "/plugin-data"

export type Pane = { pane: number, tab: number?, cwd: string?, parked: boolean?, at_prompt: boolean? }
export type Run = { argv: { string }, cb: (result: any, cx: any) -> () }
export type Timer = { at: number, fn: (cx: any) -> (), cancelled: boolean }
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
	status: (self: Harness, cwd: string?) -> any,
}

local Stub = {}

local lastCx: any = nil

-- Returns a fake WindowCx for the panes in `panes`. Each `pick` and `prompt` request goes into `cx.asked`. A
-- request keeps its options in `opts` and its `:next` callback in `next`. To answer a request, the test calls
-- `next` with `(result, err, cx)`. Each `cx:run(pane, text)` goes into `cx.typed`.
function Stub.cx(panes: { Pane }, focused: number?): any
	local asked: { any } = {}

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

	local function tab_ids(): { number }
		local ids: { number } = {}
		for _, p in panes do
			if p.tab ~= nil and table.find(ids, p.tab) == nil then
				table.insert(ids, p.tab)
			end
		end
		return ids
	end

	local cx: any = {
		asked = asked,
		toasts = {},
		typed = {},
		commands = {},
		session = {
			panes = function(_self: any): { Pane }
				return panes
			end,
			focused = function(_self: any): number?
				return focused
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
				return { { id = 1, name = "main", tabs = tab_ids(), current = true } }
			end,
			pane = function(_self: any, id: number): Pane?
				return find(id)
			end,
		},
		layout = {
			focus = function(_self: any, _pane: number) end,
			close = function(_self: any, _pane: number) end,
		},
		sessions = {
			switch = function(_self: any, _id: number) end,
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

	function cx.pick(_self: any, opts: any): any
		return ask({ kind = "pick", opts = opts })
	end

	function cx.prompt(_self: any, opts: any): any
		return ask({ kind = "prompt", opts = opts })
	end

	lastCx = cx
	return cx
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
		-- Moves the fake clock by `ms` and fires each timer that is then due, earliest first.
		tick = function(self: Harness, ms: number)
			self.clock += ms
			while true do
				local dueIndex: number? = nil
				for i, timer in self.timers do
					if timer.at <= self.clock and (dueIndex == nil or timer.at < self.timers[dueIndex].at) then
						dueIndex = i
					end
				end
				if dueIndex == nil then
					return
				end
				local timer = table.remove(self.timers, dueIndex) :: Timer
				if not timer.cancelled then
					timer.fn(defaultCx or lastCx)
				end
			end
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

return Stub
