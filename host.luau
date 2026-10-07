--!strict

local ui = tern.ui

local NEW_ID = "__new__"
local PICK_ID = "layer.pick"
local PROMPT_INPUT_ID = "layer.prompt.text"

type Item = { id: string, label: string, detail: string?, group: string? }
type Button = { id: string, label: string, kind: string? }
type Request = {
	mode: string,
	title: string,
	items: { Item }?,
	allowNew: boolean?,
	newLabel: string?,
	selected: string?,
	message: string?,
	buttons: { Button }?,
	placeholder: string?,
	text: string?,
}
type Answer = { [string]: any }
type State = {
	reqid: string,
	req: Request,
	query: string,
	selected: string?,
	text: string,
	answer: Answer?,
	focused: boolean?,
}

local function new_label(req: Request, query: string): string
	return string.format(req.newLabel or "Create “%s”", query)
end

local function offers_new(req: Request, query: string): boolean
	if not req.allowNew or query == "" then
		return false
	end
	for _, item in ipairs(req.items or {}) do
		if item.label == query then
			return false
		end
	end
	return true
end

local function matches(item: Item, needle: string): boolean
	if needle == "" then
		return true
	end
	local searchable = string.lower(item.label .. " " .. (item.detail or ""))
	return string.find(searchable, needle, 1, true) ~= nil
end

local function visible_entries(state: State): ({ string }, { any })
	local req = state.req
	local ids: { string } = {}
	local order: { any } = {}
	if offers_new(req, state.query) then
		table.insert(ids, NEW_ID)
		table.insert(order, NEW_ID)
	end
	local needle = string.lower(state.query)
	local group: string? = nil
	for _, item in ipairs(req.items or {}) do
		if matches(item, needle) then
			if item.group ~= nil and item.group ~= group then
				table.insert(order, { group = item.group, label = item.group })
			end
			group = item.group
			table.insert(ids, item.id)
			table.insert(order, item.id)
		end
	end
	return ids, order
end

local function keep_selection_visible(state: State, ids: { string })
	local selected = state.selected
	if selected ~= nil and table.find(ids, selected) ~= nil then
		return
	end
	state.selected = ids[1]
end

local function answer(state: State, value: Answer)
	state.answer = value
end

local function answer_pick(state: State, id: string?)
	if id == nil then
		return
	end
	if id == NEW_ID then
		answer(state, { action = "new", text = state.query })
	else
		answer(state, { action = "select", id = id })
	end
end

local function drop_last_char(s: string): string
	if s == "" then
		return s
	end
	local last = utf8.offset(s, -1) or #s
	return string.sub(s, 1, last - 1)
end

local function typed_text(key: Key): string?
	if key.ctrl or key.meta or key.text == nil then
		return nil
	end
	local text = string.gsub(key.text, "%c", "")
	if text == "" then
		return nil
	end
	return text
end

local function pick_view(state: State): Node
	local req = state.req
	local _, order = visible_entries(state)
	local items = tern.json.array()
	if offers_new(req, state.query) then
		table.insert(items, { id = NEW_ID, label = new_label(req, state.query) })
	end
	for _, item in ipairs(req.items or {}) do
		table.insert(items, { id = item.id, label = item.label, detail = item.detail })
	end
	return ui.col({
		ui.node("picker", {
			key = "pick",
			size = "md",
			title = req.title,
			query = state.query,
			placeholder = "Search",
			items = items,
			order = tern.json.array(order),
			selected = state.selected,
		}),
	})
end

local function confirm_view(state: State): Node
	local req = state.req
	local buttons = req.buttons or {}
	local row: { Node } = {}
	for _, button in ipairs(buttons) do
		table.insert(
			row,
			ui.el("button", { text = button.label, class = button.kind, actions = { click = "btn=" .. button.id } })
		)
	end
	local enter_label = if buttons[1] then buttons[1].label else "OK"
	return ui.col({
		ui.node("overlay", { key = "confirm", head = req.title, modal = true, size = "sm" }, {
			ui.text(req.message or ""),
			ui.row(row),
			ui.text({ ui.span("Enter: " .. enter_label .. " · Esc: cancel", "muted") }),
		}),
	})
end

local function prompt_view(state: State, cx: BlockCx): Node
	local req = state.req
	local body: { Node } = {}
	if req.message ~= nil and req.message ~= "" then
		table.insert(body, ui.text(req.message))
	end
	table.insert(body, ui.node("input", { key = "text", text = state.text, placeholder = req.placeholder }))
	if not state.focused then
		state.focused = true
		cx:frame({ { "focus", PROMPT_INPUT_ID } })
	end
	return ui.col({
		ui.node("overlay", { key = "prompt", head = req.title, modal = true, size = "sm" }, body),
	})
end

local function pick_key(state: State, key: Key): boolean
	if key.name == "escape" then
		answer(state, { action = "cancel" })
		return true
	end
	if key.name == "enter" then
		if state.selected == nil then
			return false
		end
		answer_pick(state, state.selected)
		return true
	end
	if key.name == "up" or key.name == "down" then
		local ids = visible_entries(state)
		local count = #ids
		if count == 0 then
			return false
		end
		local index = (state.selected and table.find(ids, state.selected)) or 0
		if key.name == "up" then
			index = if index <= 1 then count else index - 1
		else
			index = if index >= count then 1 else index + 1
		end
		state.selected = ids[index]
		return true
	end
	if key.name == "backspace" then
		if state.query == "" then
			return false
		end
		state.query = drop_last_char(state.query)
		keep_selection_visible(state, (visible_entries(state)))
		return true
	end
	local text = typed_text(key)
	if text == nil then
		return false
	end
	state.query ..= text
	keep_selection_visible(state, (visible_entries(state)))
	return true
end

local function confirm_key(state: State, key: Key): boolean
	local buttons = state.req.buttons or {}
	if key.name == "escape" then
		answer(state, { action = "cancel" })
		return true
	end
	if key.name == "enter" then
		if buttons[1] == nil then
			return false
		end
		answer(state, { action = "button", id = buttons[1].id })
		return true
	end
	local digit = if key.ctrl or key.meta then nil else tonumber(key.name)
	if digit ~= nil and buttons[digit] ~= nil then
		answer(state, { action = "button", id = buttons[digit].id })
		return true
	end
	return false
end

local function prompt_key(state: State, key: Key): boolean
	if key.name == "escape" then
		answer(state, { action = "cancel" })
		return true
	end
	if key.name == "enter" then
		answer(state, { action = "text", text = state.text })
		return true
	end
	if key.name == "backspace" then
		if state.text == "" then
			return false
		end
		state.text = drop_last_char(state.text)
		return true
	end
	local text = typed_text(key)
	if text == nil then
		return false
	end
	state.text ..= text
	return true
end

local def: BlockDef<State> = {
	init = function(_cx: BlockCx, args: { string }, saved: any): State
		if type(saved) == "table" and type(saved.req) == "table" then
			local restored = saved :: State
			restored.focused = false
			return restored
		end
		local req = tern.json.decode(args[2]) :: Request
		local state: State = {
			reqid = args[1],
			req = req,
			query = "",
			selected = nil,
			text = req.text or "",
			answer = nil,
			focused = false,
		}
		if req.mode == "pick" then
			local ids = visible_entries(state)
			if req.selected ~= nil and table.find(ids, req.selected) ~= nil then
				state.selected = req.selected
			end
			keep_selection_visible(state, ids)
		end
		return state
	end,

	view = function(state: State, cx: BlockCx): BlockView
		local mode = state.req.mode
		local layer: Node? = nil
		if state.answer == nil then
			if mode == "pick" then
				layer = pick_view(state)
			elseif mode == "confirm" then
				layer = confirm_view(state)
			elseif mode == "prompt" then
				layer = prompt_view(state, cx)
			end
		end
		return { main = ui.col({}), layer = layer }
	end,

	title = function(state: State): string?
		if state.answer == nil then
			return state.req.title
		end
		return "twt:" .. state.reqid .. ":" .. tern.json.encode(state.answer)
	end,

	key = function(state: State, key: Key, _cx: BlockCx): boolean?
		if state.answer ~= nil then
			return false
		end
		local mode = state.req.mode
		if mode == "pick" then
			return pick_key(state, key)
		elseif mode == "confirm" then
			return confirm_key(state, key)
		elseif mode == "prompt" then
			return prompt_key(state, key)
		end
		return false
	end,

	event = function(state: State, ev: UiEvent, cx: BlockCx)
		if state.answer ~= nil then
			return
		end
		if ev.ev == "focus" and ev.id ~= nil then
			cx:frame({ { "focus", ev.id } })
			return
		end
		if ev.ev == "select" and ev.id == PICK_ID and type(ev.item) == "string" then
			state.selected = ev.item
		elseif ev.ev == "activate" and ev.id == PICK_ID and type(ev.item) == "string" then
			state.selected = ev.item
			answer_pick(state, ev.item)
		elseif ev.ev == "action" then
			if ev.act == "close" or ev.act == "escape" then
				answer(state, { action = "cancel" })
			elseif ev.act == "clear" then
				state.query = ""
				keep_selection_visible(state, (visible_entries(state)))
			elseif ev.act == "btn" and type(ev.value) == "string" then
				answer(state, { action = "button", id = ev.value })
			end
		end
	end,

	save = function(state: State): any
		return state
	end,
}

tern.block.define("dialog", def)
