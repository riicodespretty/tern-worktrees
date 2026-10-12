--!strict

local failures = 0
local count = 0

local function show(value: any): string
	return if type(value) == "string" then string.format("%q", value) else tostring(value)
end

local Harness = {}

function Harness.test(name: string, fn: () -> ())
	count += 1
	local ok: boolean, err: any = pcall(fn)
	if ok then
		print("ok   " .. name)
	else
		failures += 1
		print("FAIL " .. name .. "\n     " .. tostring(err))
	end
end

function Harness.eq(actual: any, expected: any, what: string)
	if actual ~= expected then
		error(what .. ": expected " .. show(expected) .. ", got " .. show(actual), 2)
	end
end

function Harness.finish()
	print(string.format("%d tests, %d failed", count, failures))
	if failures > 0 then
		error(string.format("%d of %d tests failed", failures, count), 0)
	end
end

return Harness
