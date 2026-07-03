--- Cached view of `ledger status --json` for the statusline. get() is a
--- plain table read — a repeating timer plus a few event-driven pokes keep
--- the cache fresh, so a render never shells out.

local cli = require("ledger.cli")

local M = {}

local cache = { data = nil, dir = nil, fetched_at = 0 }
local timer = nil
local in_flight = false

--- Where should status be resolved from? The current buffer's directory,
--- like heartbeats — falling back to nvim's cwd for unnamed buffers.
local function current_dir()
	local name = vim.api.nvim_buf_get_name(0)
	if name == "" or name:match("^%w+://") then
		return vim.uv.cwd()
	end
	local dir = vim.fs.dirname(name)
	return vim.uv.fs_stat(dir) and dir or vim.uv.cwd()
end

function M.refresh()
	if in_flight then
		return
	end
	in_flight = true
	local dir = current_dir()
	cli.status(dir, function(data)
		in_flight = false
		cache = { data = data, dir = dir, fetched_at = vim.uv.now() }
	end)
end

--- Data from the last successful fetch, or nil while unavailable
--- (no fetch yet, binary failed, unparseable output).
function M.get()
	return cache.data
end

--- Cheap dir-change poke: switching to a buffer in another repo refreshes
--- early instead of showing the old project until the next timer tick.
function M.on_buf_enter()
	if current_dir() ~= cache.dir and vim.uv.now() - cache.fetched_at > 5000 then
		M.refresh()
	end
end

function M.start(opts)
	M.stop()
	timer = vim.uv.new_timer()
	-- 0 initial delay: populate the cache right at setup.
	timer:start(0, opts.status_refresh_interval * 1000, vim.schedule_wrap(M.refresh))
end

function M.stop()
	if timer then
		timer:stop()
		timer:close()
		timer = nil
	end
end

return M
