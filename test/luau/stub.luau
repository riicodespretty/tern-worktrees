--!strict
-- A fake `tern` and a fake WindowCx for running a plugin file under lune.

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local serde = require("@lune/serde")

local PLUGIN_DIR = "/plugin"
local DATA_DIR = "/plugin-data"

export type Pane = { pane: number, tab: number?, cwd: string?, block: string?, parked: boolean? }
export type Run = { argv: { string }, cb: (result: any, cx: any) -> () }
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
	answer: (self: Harness, verb: string, stdout: string, status: number?, cx: any?) -> (),
}

local Stub = {}

local lastCx: any = nil

-- Returns a fake WindowCx over `panes`. Every dialog request lands in `cx.asked`, through `ask` only.
-- A `pick` or `prompt` request keeps its options in `opts` and its `:next` callback in `next`, which the
-- test calls with `(result, err, cx)` to answer it.
function Stub.cx(panes: { Pane }, focused: number?): any
	local asked: { any } = {}
	local nextPane = 1000

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
					local count = 0
					for _, p in panes do
						if p.tab == id then
							count += 1
						end
					end
					table.insert(tabs, { id = id, panes = count })
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
			float = function(_self: any, _pane: number, ...: any): (boolean, string?)
				return true, nil
			end,
			focus = function(_self: any, _pane: number) end,
			close = function(_self: any, _pane: number) end,
		},
		sessions = {
			switch = function(_self: any, _id: number) end,
		},
	}

	function cx.new_block(_self: any, kind: string, args: { string }?, ...: any): number?
		nextPane += 1
		ask({ kind = kind, args = args })
		return nextPane
	end

	function cx.toast(self: any, level: string, title: string, detail: string?)
		table.insert(self.toasts, { level = level, title = title, detail = detail })
	end

	function cx.command(self: any, id: string)
		table.insert(self.commands, id)
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
	local due: { Run } = {}
	for i = #self.runs, 1, -1 do
		if self.runs[i].argv[2] == verb then
			table.insert(due, 1, table.remove(self.runs, i) :: Run)
		end
	end
	for _, run in due do
		run.cb({ stdout = stdout, stderr = "", status = status or 0 }, cx)
	end
end

-- Runs `opts.file` (default window.luau) fresh against a fake `tern`, and returns what it registered.
function Stub.load(opts: Options): Harness
	local env: { [string]: string } = opts.env or {}
	local files: { [string]: string } = opts.files or {}
	local defaultCx = opts.cx
	local h: Harness = {
		commands = {},
		overrides = {},
		handlers = {},
		exports = {},
		runs = {},
		kv = opts.kv or {},
		clock = 0,
		answer = function(self: Harness, verb: string, stdout: string, status: number?, cx: any?)
			answer(self, verb, stdout, status, cx or defaultCx or lastCx)
		end,
	}

	local fake = {
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
		css = function(_name: string, _rules: string) end,
		getenv = function(name: string): string?
			return env[name]
		end,
		kv = {
			get = function(key: string): any
				return h.kv[key]
			end,
			set = function(key: string, value: any)
				h.kv[key] = value
			end,
		},
		command = function(spec: any)
			h.commands[spec.id] = spec
		end,
		override = function(name: string, fn: (cx: any) -> any)
			h.overrides[name] = fn
		end,
		on = function(name: string, fn: (...any) -> ())
			h.handlers[name] = fn
		end,
		carly = {
			export = function(name: string, _meta: any, fn: (...any) -> ...any)
				h.exports[name] = fn
			end,
		},
		process = {
			run = function(argv: { string }, _opts: any, cb: (result: any, cx: any) -> ())
				table.insert(h.runs, { argv = argv, cb = cb })
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
			return h.clock
		end,
	}

	local file = opts.file or "window.luau"
	local environment: { [string]: any } = setmetatable({ tern = fake }, { __index = _G }) :: any
	luau.load(fs.readFile(file), { debugName = file, environment = environment })()
	return h
end

return Stub
