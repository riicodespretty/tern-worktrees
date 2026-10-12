--!strict

local Stub = require("./stub")
local runner = require("./runner")
local test, eq = runner.test, runner.eq

local REPO = "/r/app"
local ENV = { HOME = "/home/u" }
local RESOLVED = '{"repos":[{"dir":"/r/app","root":"/r/app","name":"app"}]}'
local BRANCHES = [[{"name":"app","default":"main","branches":["main","x"],
"prs":[{"number":7,"title":"Fix login","branch":"fix-login"}],
"worktrees":[{"branch":"x","path":"/wt/worktrees/app/x"}],"warnings":[]}]]

local function same(actual: { [string]: any }, expected: { [string]: any }, what: string)
	for key, value in expected do
		eq(actual[key], value, what .. "." .. key)
	end
	for key, value in actual do
		eq(expected[key], value, what .. "." .. key)
	end
end

local function argv_lines(plugin: Stub.Harness, verb: string): { string }
	local found: { string } = {}
	for _, run in plugin.runs do
		if run.argv[2] == verb then
			table.insert(found, table.concat(run.argv, " ", 2))
		end
	end
	return found
end

local function item_by_id(request: any, id: string): any
	for _, it in request.opts.items do
		if it.id == id then
			return it
		end
	end
	error("no item " .. id)
end

-- Opens the branch picker of REPO from a pane in it, and returns the harness and the cx.
local function open_branch_picker(): (Stub.Harness, any)
	local cx = Stub.cx({ { pane = 1, tab = 1, cwd = REPO } }, 1)
	local plugin = Stub.load({ env = ENV })
	plugin.commands.new.run(cx)
	plugin:answer("resolve", RESOLVED, 0, cx)
	plugin:answer("branches", BRANCHES, 0, cx)
	eq(#cx.asked, 1, "pickers and prompts opened")
	eq(cx.asked[1].kind, "pick", "request kind")
	return plugin, cx
end

-- Opens the repo picker from a window with no pane in a repository.
local function open_repo_picker(): (Stub.Harness, any)
	local cx = Stub.cx({ { pane = 1, tab = 1 } }, 1)
	local plugin = Stub.load({ env = ENV })
	plugin.commands.new.run(cx)
	eq(#cx.asked, 1, "pickers and prompts opened")
	eq(cx.asked[1].kind, "pick", "request kind")
	return plugin, cx
end

local function choose_new_branch(): (Stub.Harness, any)
	local plugin, cx = open_branch_picker()
	local picker = cx.asked[1]
	picker.next(item_by_id(picker, "new"), nil, cx)
	eq(#cx.asked, 2, "pickers and prompts opened")
	eq(cx.asked[2].kind, "prompt", "request kind")
	return plugin, cx
end

test("the branch picker lists New branch, Other repo, pull requests, then branches", function()
	local _, cx = open_branch_picker()
	local opts = cx.asked[1].opts
	eq(opts.placeholder, "Search branches in app", "placeholder")
	eq(opts.icon, "branch", "icon")
	eq(opts.action, "open", "action")
	eq(#opts.items, 5, "items")
	same(opts.items[1], { id = "new", label = "New branch…", detail = "from main", icon = "plus" }, "items[1]")
	same(opts.items[2], { id = "other", label = "Other repo…", icon = "folder" }, "items[2]")
	same(
		opts.items[3],
		{ id = "pr:7", label = "#7 Fix login · fix-login", group = "Pull requests", icon = "merge" },
		"items[3]"
	)
	same(opts.items[4], { id = "b:main", label = "main", group = "Branches", icon = "branch" }, "items[4]")
	same(
		opts.items[5],
		{ id = "b:x", label = "x", detail = "worktree", group = "Branches", icon = "branch" },
		"items[5]"
	)
end)

test("choosing a branch creates its worktree with --branch=<name>", function()
	local plugin, cx = open_branch_picker()
	local picker = cx.asked[1]
	picker.next(item_by_id(picker, "b:x"), nil, cx)
	local creates = argv_lines(plugin, "create")
	eq(#creates, 1, "create calls")
	eq(creates[1], "create --repo /r/app --no-tab --branch=x", "create argv")
end)

test("choosing a pull request creates its worktree with --pr", function()
	local plugin, cx = open_branch_picker()
	local picker = cx.asked[1]
	picker.next(item_by_id(picker, "pr:7"), nil, cx)
	eq(argv_lines(plugin, "create")[1], "create --repo /r/app --no-tab --pr 7", "create argv")
end)

test("dismissing the branch picker runs nothing", function()
	local plugin, cx = open_branch_picker()
	cx.asked[1].next(nil, nil, cx)
	eq(#plugin.runs, 0, "CLI calls")
	eq(#cx.asked, 1, "pickers and prompts opened")
end)

test("Other repo opens the repo picker", function()
	local _, cx = open_branch_picker()
	local picker = cx.asked[1]
	picker.next(item_by_id(picker, "other"), nil, cx)
	eq(#cx.asked, 2, "pickers and prompts opened")
	eq(cx.asked[2].opts.placeholder, "Search repositories", "placeholder")
end)

test("a picker error shows a toast and runs nothing", function()
	local plugin, cx = open_branch_picker()
	cx.asked[1].next(nil, "picker gone", cx)
	eq(#plugin.runs, 0, "CLI calls")
	local last = cx.toasts[#cx.toasts]
	eq(last.level, "error", "toast level")
	eq(last.title, "Picker failed", "toast title")
	eq(last.detail, "picker gone", "toast detail")
end)

test("a prompt error shows a toast and runs no create", function()
	local plugin, cx = choose_new_branch()
	cx.asked[2].next(nil, "prompt gone", cx)
	eq(#argv_lines(plugin, "create"), 0, "create calls")
	local last = cx.toasts[#cx.toasts]
	eq(last.level, "error", "toast level")
	eq(last.title, "Prompt failed", "toast title")
	eq(last.detail, "prompt gone", "toast detail")
end)

test("a picker callback with a nil cx returns at once", function()
	local plugin, cx = open_branch_picker()
	local picker = cx.asked[1]
	local toastsBefore = #cx.toasts
	picker.next(item_by_id(picker, "b:x"), nil, nil)
	picker.next(nil, "picker gone", nil)
	eq(#plugin.runs, 0, "CLI calls")
	eq(#cx.toasts, toastsBefore, "toasts")
end)

test("New branch prompts for the name of a branch from the default branch", function()
	local _, cx = choose_new_branch()
	same(
		cx.asked[2].opts,
		{ placeholder = "New branch from main in app", icon = "branch", action = "create" },
		"prompt options"
	)
end)

test("New branch creates the typed branch as one --branch=<name> argument", function()
	local plugin, cx = choose_new_branch()
	cx.asked[2].next("-bad", nil, cx)
	local creates = argv_lines(plugin, "create")
	eq(#creates, 1, "create calls")
	eq(creates[1], "create --repo /r/app --no-tab --branch=-bad --new", "create argv")
end)

local function last_title(cx: any): string
	return cx.toasts[#cx.toasts].title
end

test("a create names the branch in a reusing or creating toast while it runs", function()
	local _, cx = open_branch_picker()
	cx.asked[1].next(item_by_id(cx.asked[1], "b:x"), nil, cx)
	eq(last_title(cx), "Reusing worktree x…", "branch with a worktree")
	local _, cx2 = open_branch_picker()
	cx2.asked[1].next(item_by_id(cx2.asked[1], "b:main"), nil, cx2)
	eq(last_title(cx2), "Creating worktree main…", "branch without a worktree")
	local _, cx3 = open_branch_picker()
	cx3.asked[1].next(item_by_id(cx3.asked[1], "pr:7"), nil, cx3)
	eq(last_title(cx3), "Creating worktree fix-login…", "pull request")
	local _, cx4 = choose_new_branch()
	cx4.asked[2].next("feat/y", nil, cx4)
	eq(last_title(cx4), "Creating worktree feat/y…", "new branch")
end)

test("New branch shows the CLI's bad_args reason and prompts again with the name", function()
	local plugin, cx = choose_new_branch()
	cx.asked[2].next("bad..name", nil, cx)
	plugin:answer("create", '{"error":{"code":"bad_args","message":"invalid branch name: bad..name"}}', 1, cx)
	local last = cx.toasts[#cx.toasts]
	eq(last.level, "error", "toast level")
	eq(last.title, "invalid branch name: bad..name", "toast title")
	eq(#cx.asked, 3, "pickers and prompts opened")
	eq(cx.asked[3].kind, "prompt", "request kind")
	eq(cx.asked[3].opts.value, "bad..name", "prefilled name")
	eq(cx.asked[3].opts.placeholder, "New branch from main in app", "placeholder")
end)

test("New branch shows another CLI error and prompts no more", function()
	local plugin, cx = choose_new_branch()
	cx.asked[2].next("feat", nil, cx)
	plugin:answer("create", '{"error":{"code":"git_failed","message":"fetch failed"}}', 1, cx)
	eq(cx.toasts[#cx.toasts].title, "fetch failed", "toast title")
	eq(#cx.asked, 2, "pickers and prompts opened")
end)

test("New branch runs no create when the prompt is dismissed or empty", function()
	local plugin, cx = choose_new_branch()
	cx.asked[2].next(nil, nil, cx)
	cx.asked[2].next("", nil, cx)
	cx.asked[2].next("feat", nil, nil)
	eq(#argv_lines(plugin, "create"), 0, "create calls")
	eq(#cx.asked, 2, "pickers and prompts opened")
end)

test("the repo picker groups open sessions and GitHub", function()
	local _, cx = open_repo_picker()
	local opts = cx.asked[1].opts
	eq(opts.placeholder, "Search repositories", "placeholder")
	eq(opts.icon, "folder", "icon")
	eq(opts.action, "open", "action")
	eq(item_by_id(cx.asked[1], "github").group, "GitHub", "github group")
	eq(item_by_id(cx.asked[1], "newrepo").group, "GitHub", "newrepo group")
end)

test("GitHub repositories open a clone picker grouped by owner", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(item_by_id(cx.asked[1], "github"), nil, cx)
	plugin:answer("repos", '{"owners":["o"],"repos":[{"nameWithOwner":"o/a","description":"An app"}]}', 0, cx)
	eq(#cx.asked, 2, "pickers and prompts opened")
	local opts = cx.asked[2].opts
	eq(opts.placeholder, "Search GitHub repositories", "placeholder")
	eq(opts.icon, "globe", "icon")
	eq(opts.action, "clone", "action")
	same(opts.items[1], { id = "gh:o/a", label = "o/a", detail = "An app", group = "o", icon = "globe" }, "items[1]")
	cx.asked[2].next(opts.items[1], nil, cx)
	eq(argv_lines(plugin, "clone")[1], "clone o/a", "clone argv")
end)

test("an empty GitHub repository list opens no picker", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(item_by_id(cx.asked[1], "github"), nil, cx)
	plugin:answer("repos", '{"owners":["o"],"repos":[]}', 0, cx)
	eq(#cx.asked, 1, "pickers and prompts opened")
	local last = cx.toasts[#cx.toasts]
	eq(last.level, "info", "toast level")
	eq(last.title, "No GitHub repositories", "toast title")
end)

test("an empty owner list opens no picker", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(item_by_id(cx.asked[1], "newrepo"), nil, cx)
	plugin:answer("repos", '{"owners":[],"repos":[]}', 0, cx)
	eq(#cx.asked, 1, "pickers and prompts opened")
	eq(#cx.toasts, 1, "toasts")
end)

test("owner, name and visibility create the repository", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(item_by_id(cx.asked[1], "newrepo"), nil, cx)
	plugin:answer("repos", '{"owners":["o"],"repos":[]}', 0, cx)

	local owner = cx.asked[2]
	same(
		owner.opts,
		{ placeholder = "Search owners", icon = "user", action = "choose", items = owner.opts.items },
		"owner"
	)
	owner.next(item_by_id(owner, "o"), nil, cx)

	local name = cx.asked[3]
	eq(name.kind, "prompt", "name request kind")
	same(
		name.opts,
		{ placeholder = "Name of the new repository under o", icon = "folder-plus", action = "continue" },
		"name"
	)
	name.next("n", nil, cx)

	local visibility = cx.asked[4]
	eq(visibility.opts.placeholder, "Visibility of o/n", "visibility placeholder")
	eq(visibility.opts.action, "create", "visibility action")
	same(visibility.opts.items[1], { id = "private", label = "Private", icon = "lock" }, "items[1]")
	same(visibility.opts.items[2], { id = "public", label = "Public", icon = "globe" }, "items[2]")
	visibility.next(item_by_id(visibility, "private"), nil, cx)

	eq(argv_lines(plugin, "new-repo")[1], "new-repo o/n --visibility private", "new-repo argv")
end)

test("an empty repository name ends the flow", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(item_by_id(cx.asked[1], "newrepo"), nil, cx)
	plugin:answer("repos", '{"owners":["o"],"repos":[]}', 0, cx)
	cx.asked[2].next(item_by_id(cx.asked[2], "o"), nil, cx)
	cx.asked[3].next("", nil, cx)
	cx.asked[3].next(nil, nil, cx)
	eq(#cx.asked, 3, "pickers and prompts opened")
end)

test("dismissing or failing the GitHub repository picker clones nothing", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(item_by_id(cx.asked[1], "github"), nil, cx)
	plugin:answer("repos", '{"owners":["o"],"repos":[{"nameWithOwner":"o/a"}]}', 0, cx)
	cx.asked[2].next(nil, nil, cx)
	cx.asked[2].next(nil, "gone", cx)
	cx.asked[2].next(item_by_id(cx.asked[2], "gh:o/a"), "gone", cx)
	eq(#argv_lines(plugin, "clone"), 0, "clone calls")
end)

test("dismissing or failing the visibility picker makes no repository", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(item_by_id(cx.asked[1], "newrepo"), nil, cx)
	plugin:answer("repos", '{"owners":["o"],"repos":[]}', 0, cx)
	cx.asked[2].next(item_by_id(cx.asked[2], "o"), nil, cx)
	cx.asked[3].next("n", nil, cx)
	cx.asked[4].next(nil, nil, cx)
	cx.asked[4].next(nil, "gone", cx)
	cx.asked[4].next(item_by_id(cx.asked[4], "private"), "gone", cx)
	eq(#argv_lines(plugin, "new-repo"), 0, "new-repo calls")
end)

test("dismissing or failing the repo picker runs nothing", function()
	local plugin, cx = open_repo_picker()
	cx.asked[1].next(nil, nil, cx)
	cx.asked[1].next(nil, "gone", cx)
	cx.asked[1].next(item_by_id(cx.asked[1], "github"), "gone", cx)
	cx.asked[1].next(item_by_id(cx.asked[1], "newrepo"), "gone", cx)
	eq(#plugin.runs, 0, "CLI calls")
	eq(#cx.asked, 1, "pickers and prompts opened")
end)

test("a bad_args error of a chosen branch shows a toast and prompts nothing", function()
	local plugin, cx = open_branch_picker()
	cx.asked[1].next(item_by_id(cx.asked[1], "b:x"), nil, cx)
	plugin:answer("create", '{"error":{"code":"bad_args","message":"bad branch name x"}}', 1, cx)
	eq(#cx.asked, 1, "pickers and prompts opened")
	local last = cx.toasts[#cx.toasts]
	eq(last.level, "error", "toast level")
	eq(last.title, "bad branch name x", "toast title")
end)

runner.finish()
