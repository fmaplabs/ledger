-- Entry point sourced by the plugin manager. Command definition only —
-- everything else waits until setup()/first use.

if vim.g.loaded_ledger then
	return
end
vim.g.loaded_ledger = true

local actions = { "status", "enable", "disable" }

vim.api.nvim_create_user_command("Ledger", function(cmd)
	local ledger = require("ledger")
	if not ledger.did_setup then
		ledger.setup({})
	end

	local action = cmd.fargs[1] or "status"
	if action == "enable" then
		ledger.enable()
		vim.notify("ledger.nvim: tracking enabled")
	elseif action == "disable" then
		ledger.disable()
		vim.notify("ledger.nvim: tracking disabled")
	elseif action == "status" then
		local name = vim.api.nvim_buf_get_name(0)
		local dir = name ~= "" and vim.fs.dirname(name) or vim.uv.cwd()
		require("ledger.cli").status_line(dir, function(line)
			if not line then
				vim.notify("ledger.nvim: status unavailable", vim.log.levels.WARN)
				return
			end
			if not ledger.enabled then
				line = line .. " (tracking disabled)"
			end
			vim.notify(line)
		end)
	else
		vim.notify("ledger.nvim: unknown action " .. action, vim.log.levels.ERROR)
	end
end, {
	nargs = "?",
	complete = function(arglead)
		return vim.tbl_filter(function(a)
			return vim.startswith(a, arglead)
		end, actions)
	end,
	desc = "ledger time tracking: status | enable | disable",
})
