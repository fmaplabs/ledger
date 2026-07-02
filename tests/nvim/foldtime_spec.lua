-- Headless smoke tests: drive the plugin with real autocmds against the
-- bash shim on PATH, then assert on the "cwd|argv" lines it logged.
-- Run via tests/nvim/run.sh; plain asserts, exit code 1 on any failure.

vim.notify = function() end -- keep enable/disable chatter out of the output

local log_path = vim.env.FOLDTIME_SHIM_LOG

--- Heartbeat calls logged by the shim (status --json fetches from the
--- statusline cache also hit the shim, but aren't what these cases count).
local function shim_lines()
	local f = io.open(log_path, "r")
	if not f then
		return {}
	end
	local lines = {}
	for line in f:lines() do
		if line:find("|heartbeat ", 1, true) then
			lines[#lines + 1] = line
		end
	end
	f:close()
	return lines
end

--- Wait (pumping the event loop, so vim.system callbacks run) until the
--- shim has logged at least `n` lines, then let stragglers land.
local function settled_lines(n)
	vim.wait(2000, function()
		return #shim_lines() >= n
	end, 10)
	vim.wait(200)
	return shim_lines()
end

local failed = false
local function check(name, fn)
	local ok, err = pcall(fn)
	print((ok and "ok   " or "FAIL ") .. name .. (ok and "" or ": " .. tostring(err)))
	failed = failed or not ok
end

-- One temp workspace for all cases. A bare .git entry is all the repo
-- guard looks for (vim.fs.root) — no real git needed.
local dir = vim.fn.tempname()
vim.fn.mkdir(dir .. "/.git", "p")
local function workspace_file(name)
	local path = dir .. "/" .. name
	local f = assert(io.open(path, "w"))
	f:write("hello\n")
	f:close()
	return path
end

local file1 = workspace_file("one.txt")
local file2 = workspace_file("two.txt")
local file3 = workspace_file("three.txt")

require("foldtime").setup({})

check("editing a file sends one heartbeat from the file's directory", function()
	vim.cmd.edit(file1)
	local lines = settled_lines(1)
	assert(#lines == 1, "expected 1 shim call, got " .. #lines)
	assert(lines[1] == dir .. "|heartbeat --file " .. file1, "unexpected call: " .. lines[1])
end)

check("activity within the interval is throttled", function()
	vim.api.nvim_exec_autocmds("CursorMoved", { buffer = 0 })
	vim.api.nvim_exec_autocmds("TextChanged", { buffer = 0 })
	vim.wait(300)
	assert(#shim_lines() == 1, "throttle leaked: " .. #shim_lines() .. " calls")
end)

check("a write bypasses the throttle and carries --write", function()
	vim.cmd.write()
	local lines = settled_lines(2)
	assert(#lines == 2, "expected 2 shim calls, got " .. #lines)
	assert(lines[2] == dir .. "|heartbeat --file " .. file1 .. " --write", "unexpected call: " .. lines[2])
end)

check("a second file sends within the window (throttle is per file)", function()
	vim.cmd.edit(file2)
	local lines = settled_lines(3)
	assert(#lines == 3, "expected 3 shim calls, got " .. #lines)
	assert(lines[3] == dir .. "|heartbeat --file " .. file2, "unexpected call: " .. lines[3])
end)

check("special buffers (buftype=nofile) send nothing", function()
	local before = #shim_lines()
	local buf = vim.api.nvim_create_buf(false, true) -- scratch: buftype=nofile
	vim.api.nvim_set_current_buf(buf)
	vim.api.nvim_exec_autocmds("CursorMoved", { buffer = buf })
	vim.wait(300)
	assert(#shim_lines() == before, "scratch buffer produced a heartbeat")
end)

check(":FoldTime disable stops sends, enable resumes them", function()
	vim.cmd("FoldTime disable")
	vim.cmd.edit(file3) -- fresh file: only the disabled flag can stop it
	vim.wait(300)
	local before = #shim_lines()
	assert(before == 3, "disable did not stop heartbeats: " .. before .. " calls")

	vim.cmd("FoldTime enable")
	vim.api.nvim_exec_autocmds("CursorMoved", { buffer = 0 })
	local lines = settled_lines(before + 1)
	assert(#lines == before + 1, "enable did not resume heartbeats")
	assert(lines[#lines] == dir .. "|heartbeat --file " .. file3, "unexpected call: " .. lines[#lines])
end)

check("files outside a git repo send nothing", function()
	local before = #shim_lines()
	local outside = vim.fn.tempname()
	vim.fn.mkdir(outside, "p")
	local f = assert(io.open(outside .. "/note.txt", "w"))
	f:write("hello\n")
	f:close()
	vim.cmd.edit(outside .. "/note.txt")
	vim.wait(300)
	assert(#shim_lines() == before, "non-repo file produced a heartbeat")
end)

check("status cache feeds the lualine component", function()
	local status = require("foldtime.status")
	local lualine = require("foldtime.lualine")
	status.refresh()
	vim.wait(2000, function()
		return status.get() ~= nil
	end, 10)
	local text = lualine.get()
	assert(text:find("1h"), "expected the shim's 1h in: " .. text) -- canned 3600000 ms
	assert(lualine.has(), "has() should be true with the canned project")
end)

if failed then
	vim.cmd("cquit 1")
end
