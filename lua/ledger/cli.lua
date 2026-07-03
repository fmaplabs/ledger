--- Spawning the ledger binary. Everything here is fire-and-forget or
--- callback-based; nothing blocks the editor.

local M = {}

local cmd = "ledger"

--- Memoized spawn failure (binary missing mid-session, etc.): surfaced once
--- via vim.notify, kept around for :checkhealth.
M.spawn_error = nil

function M.setup(opts)
	cmd = opts.cmd
	M.spawn_error = nil
end

function M.command()
	return cmd
end

function M.available()
	return vim.fn.executable(cmd) == 1
end

--- pcall-wrapped vim.system: vim.system throws synchronously on ENOENT,
--- which must never take a keystroke autocmd down with it.
local function spawn(args, opts, on_exit)
	local argv = { cmd }
	vim.list_extend(argv, args)
	local ok, err = pcall(vim.system, argv, opts, on_exit)
	if not ok and not M.spawn_error then
		M.spawn_error = tostring(err)
		vim.schedule(function()
			vim.notify("ledger.nvim: could not run " .. cmd .. ": " .. M.spawn_error, vim.log.levels.WARN)
		end)
	end
	return ok
end

--- Record a heartbeat for `file`. cwd is the *buffer's* directory, not
--- nvim's — tracking follows each buffer's repo in multi-repo editing.
function M.heartbeat(file, is_write)
	local args = { "heartbeat", "--file", file }
	if is_write then
		args[#args + 1] = "--write"
	end
	spawn(args, { cwd = vim.fs.dirname(file), stdout = false, stderr = false }, function() end)
end

--- Fetch `status --json` for `dir`; cb(table|nil) on the main loop.
--- nil means unavailable: nonzero exit, unparseable output, or spawn failure.
function M.status(dir, cb)
	local function finish(data)
		vim.schedule(function()
			cb(data)
		end)
	end
	local spawned = spawn({ "status", "--json" }, { cwd = dir, text = true }, function(out)
		if out.code ~= 0 or not out.stdout or out.stdout == "" then
			return finish(nil)
		end
		local ok, data = pcall(vim.json.decode, out.stdout, { luanil = { object = true } })
		finish(ok and data or nil)
	end)
	if not spawned then
		finish(nil)
	end
end

--- Human one-liner from `status` (no --json), for :Ledger status.
function M.status_line(dir, cb)
	local spawned = spawn({ "status" }, { cwd = dir, text = true }, function(out)
		vim.schedule(function()
			cb(out.code == 0 and vim.trim(out.stdout or "") or nil)
		end)
	end)
	if not spawned then
		vim.schedule(function()
			cb(nil)
		end)
	end
end

return M
