-- Entry point sourced by the plugin manager. Command definition only —
-- everything else waits until setup()/first use.

if vim.g.loaded_foldtime then
	return
end
vim.g.loaded_foldtime = true

local actions = { "status", "enable", "disable" }

vim.api.nvim_create_user_command("FoldTime", function(cmd)
	local foldtime = require("foldtime")
	if not foldtime.did_setup then
		foldtime.setup({})
	end

	local action = cmd.fargs[1] or "status"
	if action == "enable" then
		foldtime.enable()
		vim.notify("foldtime.nvim: tracking enabled")
	elseif action == "disable" then
		foldtime.disable()
		vim.notify("foldtime.nvim: tracking disabled")
	elseif action == "status" then
		local name = vim.api.nvim_buf_get_name(0)
		local dir = name ~= "" and vim.fs.dirname(name) or vim.uv.cwd()
		require("foldtime.cli").status_line(dir, function(line)
			if not line then
				vim.notify("foldtime.nvim: status unavailable", vim.log.levels.WARN)
				return
			end
			if not foldtime.enabled then
				line = line .. " (tracking disabled)"
			end
			vim.notify(line)
		end)
	else
		vim.notify("foldtime.nvim: unknown action " .. action, vim.log.levels.ERROR)
	end
end, {
	nargs = "?",
	complete = function(arglead)
		return vim.tbl_filter(function(a)
			return vim.startswith(a, arglead)
		end, actions)
	end,
	desc = "foldTime time tracking: status | enable | disable",
})
