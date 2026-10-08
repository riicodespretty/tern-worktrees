--!strict

local ui = tern.ui

local NEW_ID = "__new__"
local UNGROUPED = "__ungrouped__"
-- NOTE: The dialog protocol constants and the Item and Button types below must match the block at the top of window.luau. Change both files together.
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
local CARD_KEY = "card"
local PICK_KEY = "pick"
local PROMPT_KEY = "prompt"
local TEXT_KEY = "text"
local PICK_ID = "layer." .. CARD_KEY .. "." .. PICK_KEY
local PROMPT_INPUT_ID = "layer." .. PROMPT_KEY .. "." .. TEXT_KEY
local ESCAPE_LABEL = "cancel"
local DOUBLE_CLICK_MS = 500
local PAGE_ROWS = 8

type Item = { id: string, label: string, detail: string?, group: string?, icon: string? }
type Button = { id: string, label: string, kind: ("primary" | "danger" | typeof(KIND_CANCEL))? }
type PickRequest = {
	mode: typeof(MODE_PICK),
	title: string,
	items: { Item }?,
	allowNew: boolean?,
	newLabel: string?,
	selected: string?,
	placeholder: string?,
	verb: string?,
}
type ConfirmRequest = {
	mode: typeof(MODE_CONFIRM),
	title: string,
	message: string?,
	path: string?,
	listing: { string }?,
	buttons: { Button }?,
}
type PromptRequest = {
	mode: typeof(MODE_PROMPT),
	title: string,
	message: string?,
	placeholder: string?,
	verb: string?,
	text: string?,
}
type Request = PickRequest | ConfirmRequest | PromptRequest
type Answer =
	{ action: typeof(ACTION_CANCEL) }
	| { action: typeof(ACTION_NEW), text: string }
	| { action: typeof(ACTION_SELECT), id: string }
	| { action: typeof(ACTION_BUTTON), id: string }
	| { action: typeof(ACTION_TEXT), text: string }
type State = {
	reqid: string,
	req: Request,
	query: string,
	selected: string?,
	text: string,
	answer: Answer?,
	focused: boolean?,
	openedAt: number,
	keyed: boolean?,
}

local function new_label(req: PickRequest, query: string): string
	return string.format(req.newLabel or "Create “%s”", query)
end

local function offers_new(req: PickRequest, query: string): boolean
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

local function visible_entries(state: State): ({ string }, { any }, boolean)
	local req = state.req :: PickRequest
	local ids: { string } = {}
	local order: { any } = {}
	local offers = offers_new(req, state.query)
	if offers then
		table.insert(ids, NEW_ID)
		table.insert(order, NEW_ID)
	end
	local needle = string.lower(state.query)
	local group: string? = nil
	for _, item in ipairs(req.items or {}) do
		if matches(item, needle) then
			if item.group ~= group then
				if item.group ~= nil then
					table.insert(order, { group = item.group, label = item.group })
				else
					table.insert(order, { group = UNGROUPED, label = "Other" })
				end
			end
			group = item.group
			table.insert(ids, item.id)
			table.insert(order, item.id)
		end
	end
	return ids, order, offers
end

local function group_starts(order: { any }): { string }
	local starts: { string } = {}
	local after_header = true
	for _, entry in ipairs(order) do
		if type(entry) == "table" then
			after_header = true
		elseif after_header then
			table.insert(starts, entry)
			after_header = false
		end
	end
	return starts
end

local function keep_selection_visible(state: State, ids: { string })
	local selected = state.selected
	if selected ~= nil and table.find(ids, selected) ~= nil then
		return
	end
	state.selected = ids[1]
end

local function select_top(state: State)
	state.selected = (visible_entries(state))[1]
	state.keyed = false
end

local function moved_index(name: string, index: number, count: number): number?
	if name == "up" then
		return if index <= 1 then count else index - 1
	elseif name == "down" then
		return if index >= count then 1 else index + 1
	elseif name == "home" then
		return 1
	elseif name == "end" then
		return count
	elseif name == "page_up" then
		return math.max(index - PAGE_ROWS, 1)
	elseif name == "page_down" then
		return math.min(index + PAGE_ROWS, count)
	end
	return nil
end

local function next_group_start(starts: { string }, ids: { string }, selected: string?, backward: boolean): string?
	local count = #starts
	if count == 0 then
		return nil
	end
	local index = (selected and table.find(ids, selected)) or 0
	local current = 0
	for i, id in ipairs(starts) do
		if (table.find(ids, id) :: number) <= index then
			current = i
		end
	end
	if backward then
		return starts[if current <= 1 then count else current - 1]
	end
	return starts[if current >= count then 1 else current + 1]
end

local function answer_pick(state: State, id: string?)
	if id == nil then
		return
	end
	if id == NEW_ID then
		state.answer = { action = ACTION_NEW, text = state.query }
	else
		state.answer = { action = ACTION_SELECT, id = id }
	end
end

local function drop_last_char(s: string): string
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

local function edit_text(s: string, key: Key): string?
	if key.name == "backspace" then
		if s == "" then
			return nil
		end
		return drop_last_char(s)
	end
	local text = typed_text(key)
	if text == nil then
		return nil
	end
	return s .. text
end

local function kbd(key: string, hidden: boolean?): Node
	return ui.el("span", { class = "kbd", text = key, attrs = if hidden then { ["aria-hidden"] = "true" } else nil })
end

local function hint(keys: { string }, label: string, class: string?): Node
	local parts: { Node } = {}
	for _, key in ipairs(keys) do
		table.insert(parts, kbd(key))
	end
	table.insert(parts, ui.el("span", { text = label }))
	return ui.el("span", { class = class }, parts)
end

local function palette_card(node_key: string, aria: string, children: { Node }, modifier: string?): Node
	return ui.col({
		ui.el("div", { class = "twt-dim", actions = { click = "close" } }),
		ui.el("div", {
			key = node_key,
			class = if modifier then "cmdk tn-cmdk twt-card " .. modifier else "cmdk tn-cmdk twt-card",
			attrs = { role = "dialog", ["aria-modal"] = "true", ["aria-label"] = aria },
		}, children),
	})
end

local function footer_hints(verb: string, navigate: boolean): Node
	local hints: { Node } = {}
	if navigate then
		table.insert(hints, hint({ "↑", "↓" }, "navigate"))
	end
	table.insert(hints, hint({ "↵" }, verb))
	table.insert(hints, hint({ "esc" }, ESCAPE_LABEL, "grow"))
	return ui.el("div", { class = "ck-foot" }, hints)
end

local function pick_view(state: State, _cx: BlockCx): Node
	local req = state.req :: PickRequest
	local _, order, offers = visible_entries(state)
	local items = tern.json.array()
	if offers then
		table.insert(items, { id = NEW_ID, label = new_label(req, state.query), icon = "plus" })
	end
	for _, item in ipairs(req.items or {}) do
		table.insert(items, { id = item.id, label = item.label, detail = item.detail, icon = item.icon })
	end
	local placeholder = req.placeholder or req.title
	return palette_card(CARD_KEY, placeholder, {
		ui.node("picker", {
			key = PICK_KEY,
			size = "screen",
			preview = "none",
			icon = "search",
			query = state.query,
			placeholder = placeholder,
			items = items,
			order = tern.json.array(order),
			selected = state.selected,
		}),
		footer_hints(req.verb or "open", true),
	}, if state.keyed then "twt-keyed" else nil)
end

local function button_shortcut(button: Button, index: number): string
	if index == 1 then
		return "↵"
	elseif button.kind == KIND_CANCEL then
		return "esc"
	end
	return tostring(index)
end

local ARIA_KEYS: { [string]: string } = { ["↵"] = "Enter", esc = "Escape" }

local function confirm_view(state: State, _cx: BlockCx): Node
	local req = state.req :: ConfirmRequest
	local buttons = req.buttons or {}
	local titles: { Node } = { ui.el("div", { class = "mdl-t", text = req.title }) }
	if req.path ~= nil and req.path ~= "" then
		table.insert(titles, ui.el("div", { class = "mdl-sub twt-mono", text = req.path }))
	end
	local body: { Node } = {}
	if req.message ~= nil and req.message ~= "" then
		table.insert(body, ui.el("div", { class = "twt-msg", text = req.message }))
	end
	if req.listing ~= nil and #req.listing > 0 then
		local lines: { Node } = {}
		for _, line in ipairs(req.listing) do
			table.insert(lines, ui.el("div", { class = "twt-line", text = line }))
		end
		table.insert(body, ui.el("div", { class = "twt-detail twt-mono" }, lines))
	end
	local lead: { Node } = {}
	local actions: { Node } = {}
	local danger = false
	for i = #buttons, 1, -1 do
		local button = buttons[i]
		local class = "btn mdl-go twt-btn"
		if button.kind == "danger" then
			class ..= " bad"
			danger = true
		elseif button.kind == "primary" then
			class ..= " accent"
		end
		local shortcut = button_shortcut(button, i)
		local node = ui.el("button", {
			class = class,
			attrs = { ["aria-keyshortcuts"] = ARIA_KEYS[shortcut] or shortcut },
			actions = { click = "btn=" .. button.id },
		}, {
			ui.el("span", { text = button.label }),
			kbd(shortcut, true),
		})
		table.insert(if button.kind == KIND_CANCEL then lead else actions, node)
	end
	if #lead == 0 then
		table.insert(lead, hint({ "esc" }, ESCAPE_LABEL, "twt-hint"))
	end
	local foot: { Node } = { ui.el("div", { class = "mdl-lead" }, lead) }
	for _, node in ipairs(actions) do
		table.insert(foot, node)
	end
	local children: { Node } = {
		ui.el("div", { class = "mdl-head" }, { ui.el("div", { class = "mdl-titles" }, titles) }),
	}
	if #body > 0 then
		table.insert(children, ui.el("div", { class = "mdl-body" }, body))
	end
	table.insert(children, ui.el("div", { class = "mdl-foot" }, foot))
	return palette_card("confirm", req.title, children, if danger then "twt-danger" else nil)
end

local function prompt_view(state: State, cx: BlockCx): Node
	local req = state.req :: PromptRequest
	local children: { Node } = {
		ui.el("div", { class = "ck-top" }, {
			ui.node("icon", { name = "pen" }),
			ui.node("input", { key = TEXT_KEY, text = state.text, placeholder = req.placeholder or req.title }),
		}),
	}
	if req.message ~= nil and req.message ~= "" then
		table.insert(children, ui.el("div", { class = "twt-msg" }, { ui.text(req.message) }))
	end
	table.insert(children, footer_hints(req.verb or "OK", false))
	if not state.focused then
		state.focused = true
		cx:frame({ { "focus", PROMPT_INPUT_ID } })
	end
	return palette_card(PROMPT_KEY, req.title, children)
end

local function pick_key(state: State, key: Key): boolean
	if key.name == "enter" then
		if state.selected == nil then
			return false
		end
		answer_pick(state, state.selected)
		return true
	end
	if key.name == "tab" and not (key.ctrl or key.meta or key.alt) then
		local ids, order = visible_entries(state)
		local target = next_group_start(group_starts(order), ids, state.selected, key.shift)
		if target == nil or target == state.selected then
			return false
		end
		state.selected = target
		state.keyed = true
		return true
	end
	if not (key.ctrl or key.meta or key.alt) then
		local ids = visible_entries(state)
		local count = #ids
		local index = (state.selected and table.find(ids, state.selected)) or 0
		local target = if count > 0 then moved_index(key.name, index, count) else nil
		if target ~= nil then
			if ids[target] == state.selected then
				return false
			end
			state.selected = ids[target]
			state.keyed = true
			return true
		end
	end
	local query = edit_text(state.query, key)
	if query == nil then
		return false
	end
	state.query = query
	select_top(state)
	return true
end

local function confirm_key(state: State, key: Key): boolean
	local buttons = (state.req :: ConfirmRequest).buttons or {}
	if key.name == "enter" then
		if buttons[1] == nil then
			return false
		end
		state.answer = { action = ACTION_BUTTON, id = buttons[1].id }
		return true
	end
	local digit = if key.ctrl or key.meta then nil else tonumber(key.name)
	if digit ~= nil and buttons[digit] ~= nil then
		state.answer = { action = ACTION_BUTTON, id = buttons[digit].id }
		return true
	end
	return false
end

local function prompt_key(state: State, key: Key): boolean
	if key.name == "enter" then
		state.answer = { action = ACTION_TEXT, text = state.text }
		return true
	end
	local text = edit_text(state.text, key)
	if text == nil then
		return false
	end
	state.text = text
	return true
end

type ModeHandlers = {
	view: (state: State, cx: BlockCx) -> Node,
	key: (state: State, key: Key) -> boolean,
}

local MODES: { [string]: ModeHandlers? } = {
	[MODE_PICK] = { view = pick_view, key = pick_key },
	[MODE_CONFIRM] = { view = confirm_view, key = confirm_key },
	[MODE_PROMPT] = { view = prompt_view, key = prompt_key },
}

local def: BlockDef<State> = {
	init = function(_cx: BlockCx, args: { string }, saved: any): State
		if type(saved) == "table" and type(saved.req) == "table" then
			local restored = saved :: State
			restored.focused = false
			restored.openedAt = tern.now()
			return restored
		end
		local req = tern.json.decode(args[2]) :: Request
		local state: State = {
			reqid = args[1],
			req = req,
			query = "",
			selected = nil,
			text = if req.mode == MODE_PROMPT then req.text or "" else "",
			answer = nil,
			focused = false,
			openedAt = tern.now(),
		}
		if req.mode == MODE_PICK then
			local ids = visible_entries(state)
			if req.selected ~= nil and table.find(ids, req.selected) ~= nil then
				state.selected = req.selected
			end
			keep_selection_visible(state, ids)
		end
		return state
	end,

	view = function(state: State, cx: BlockCx): BlockView
		local layer: Node? = nil
		local handlers = MODES[state.req.mode]
		if state.answer == nil and handlers ~= nil then
			layer = handlers.view(state, cx)
		end
		return { main = ui.col({}), layer = layer }
	end,

	title = function(state: State): string?
		if state.answer == nil then
			return state.req.title
		end
		return TITLE_PREFIX .. state.reqid .. ":" .. tern.json.encode(state.answer)
	end,

	key = function(state: State, key: Key, _cx: BlockCx): boolean?
		if state.answer ~= nil then
			return false
		end
		local handlers = MODES[state.req.mode]
		if handlers == nil then
			return false
		end
		if key.name == "escape" then
			state.answer = { action = ACTION_CANCEL }
			return true
		end
		return handlers.key(state, key)
	end,

	event = function(state: State, ev: UiEvent, cx: BlockCx)
		if state.answer ~= nil then
			return
		end
		if ev.ev == "focus" and ev.id ~= nil then
			cx:frame({ { "focus", ev.id } })
			return
		end
		if tern.now() - state.openedAt < DOUBLE_CLICK_MS then
			return
		end
		if (ev.ev == "select" or ev.ev == "activate") and ev.id == PICK_ID and type(ev.item) == "string" then
			state.selected = ev.item
			answer_pick(state, ev.item)
		elseif ev.ev == "action" then
			if ev.act == "close" or ev.act == "escape" then
				state.answer = { action = ACTION_CANCEL }
			elseif ev.act == "clear" then
				state.query = ""
				select_top(state)
			elseif ev.act == "btn" and type(ev.value) == "string" then
				state.answer = { action = ACTION_BUTTON, id = ev.value }
			end
		end
	end,

	save = function(state: State): any
		return state
	end,
}

tern.block.define("dialog", def)
