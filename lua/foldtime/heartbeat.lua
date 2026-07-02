--- Guards and per-file throttling in front of `foldtime heartbeat`.
--- The autocmd handlers land here on every keystroke, so the fast path is
--- one table lookup and a monotonic-clock compare.

local cli = require("foldtime.cli")

local M = {}

local interval_ms = 120 * 1000
local exclude_filetypes = {}
local last_sent = {} -- absolute file path → vim.uv.now() of the last send

--- Last heartbeat actually sent (any file), for :checkhealth.
M.last_send = nil

function M.setup(opts)
	interval_ms = opts.heartbeat_interval * 1000
	exclude_filetypes = {}
	for _, ft in ipairs(opts.exclude_filetypes) do
		exclude_filetypes[ft] = true
	end
	M.reset()
end

function M.reset()
	last_sent = {}
end

--- Is this buffer a real file worth tracking? Returns its path, or nil.
--- Ordered cheapest-first: these run on CursorMoved.
local function eligible_file(buf)
	if vim.bo[buf].buftype ~= "" then
		return nil
	end
	local name = vim.api.nvim_buf_get_name(buf)
	if name == "" or name:match("^%w+://") then
		return nil -- unnamed, or a scheme buffer like oil:// / fugitive://
	end
	if exclude_filetypes[vim.bo[buf].filetype] then
		return nil
	end
	-- The dirname becomes vim.system's cwd, which errors if it's gone.
	if not vim.uv.fs_stat(vim.fs.dirname(name)) then
		return nil
	end
	return name
end

local function send(file, is_write)
	local now = vim.uv.now()
	local last = last_sent[file]
	if not is_write and last and now - last < interval_ms then
		return
	end
	last_sent[file] = now
	M.last_send = { file = file, at = os.time(), write = is_write }
	cli.heartbeat(file, is_write)
end

function M.on_activity(buf)
	local file = eligible_file(buf)
	if file then
		send(file, false)
	end
end

--- Saves always record (that's what --write marks), throttle or not.
function M.on_write(buf)
	local file = eligible_file(buf)
	if file then
		send(file, true)
	end
end

return M
