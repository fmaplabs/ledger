--- :checkhealth ledger

local M = {}

function M.check()
	local health = vim.health
	health.start("ledger")

	if vim.fn.has("nvim-0.10") ~= 1 then
		health.error("neovim >= 0.10 is required (vim.system)")
		return
	end
	health.ok("neovim >= 0.10")

	local ledger = require("ledger")
	if not ledger.did_setup then
		health.warn("setup() has not run", { "call require('ledger').setup({})" })
		return
	end

	local cli = require("ledger.cli")
	local cmd = cli.command()
	if not cli.available() then
		health.error(("%q is not executable"):format(cmd), {
			"cargo install --path <ledger repo>",
			"or set opts.cmd to an absolute path — GUI-launched nvim often lacks ~/.cargo/bin on PATH",
		})
		return
	end
	health.ok(("binary: %s → %s"):format(cmd, vim.fn.exepath(cmd)))

	-- Handshake: a binary from before `status --json` exits nonzero here.
	local out = vim.system({ cmd, "status", "--json" }, { text = true }):wait()
	local ok, data = pcall(vim.json.decode, out.stdout or "", { luanil = { object = true } })
	if out.code ~= 0 or not ok or type(data) ~= "table" then
		health.error("`" .. cmd .. " status --json` did not answer", {
			"binary too old? reinstall: cargo install --path <ledger repo>",
		})
	elseif data.project then
		health.ok(("git repo: project %s, task %s"):format(data.project, data.task or "?"))
	else
		health.info("not inside a git repo — heartbeats from here are silently skipped")
	end

	health.info("tracking " .. (ledger.enabled and "enabled" or "disabled (:Ledger enable)"))
	health.info(
		("heartbeat_interval %ds, status_refresh_interval %ds"):format(
			ledger.options.heartbeat_interval,
			ledger.options.status_refresh_interval
		)
	)

	local last = require("ledger.heartbeat").last_send
	if last then
		health.info(
			("last heartbeat: %s%s at %s"):format(last.file, last.write and " [write]" or "", os.date("%T", last.at))
		)
	else
		health.info("no heartbeats sent this session yet")
	end

	if cli.spawn_error then
		health.warn("an earlier spawn failed: " .. cli.spawn_error)
	end
end

return M
