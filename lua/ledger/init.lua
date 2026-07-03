--- ledger.nvim — automatic heartbeats for the ledger time tracker.
--- setup() is idempotent: safe to call again with new options at any time.

local M = {}

local defaults = {
	cmd = "ledger", -- binary name, or an absolute path if not on PATH
	heartbeat_interval = 120, -- seconds; per-file throttle between heartbeats
	status_refresh_interval = 30, -- seconds; statusline data refresh cadence
	exclude_filetypes = {},
}

M.enabled = true
M.did_setup = false
M.options = nil

local warned_missing = false

function M.setup(opts)
	M.options = vim.tbl_deep_extend("force", defaults, opts or {})
	M.did_setup = true

	local cli = require("ledger.cli")
	local heartbeat = require("ledger.heartbeat")
	local status = require("ledger.status")
	cli.setup(M.options)
	heartbeat.setup(M.options)

	if not cli.available() then
		if not warned_missing then
			warned_missing = true
			vim.notify(
				("ledger.nvim: %q not found — heartbeats off. Set opts.cmd or run `cargo install --path <ledger repo>`."):format(
					M.options.cmd
				),
				vim.log.levels.WARN
			)
		end
		return -- dormant: no autocmds, nothing to clean up
	end

	local group = vim.api.nvim_create_augroup("ledger", { clear = true })
	vim.api.nvim_create_autocmd({ "BufEnter", "CursorMoved", "CursorMovedI", "TextChanged", "TextChangedI" }, {
		group = group,
		callback = function(ev)
			if M.enabled then
				heartbeat.on_activity(ev.buf)
			end
		end,
	})
	vim.api.nvim_create_autocmd("BufWritePost", {
		group = group,
		callback = function(ev)
			if M.enabled then
				heartbeat.on_write(ev.buf)
				-- refresh after the row lands so the statusline ticks up
				vim.defer_fn(status.refresh, 1000)
			end
		end,
	})
	vim.api.nvim_create_autocmd("BufEnter", {
		group = group,
		callback = function()
			status.on_buf_enter()
		end,
	})

	status.start(M.options)
end

function M.enable()
	M.enabled = true
end

function M.disable()
	M.enabled = false
end

return M
