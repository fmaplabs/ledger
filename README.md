# ledger

Commit-based time tracking for freelance software developers. Editor plugins
send heartbeats while you work; a git `post-commit` hook stamps each burst of
work with the commit that came out of it. Everything is stored locally in
SQLite (`~/.ledger/ledger.db`), so tracking works offline.

## Install

```sh
cargo install --path .
```

(or `cargo build --release` and copy `target/release/ledger` somewhere on
your `PATH` — the post-commit hook invokes `ledger` by name, so it must be
on `PATH` for tagging to work).

## Usage

Set up a repo (installs `.git/hooks/post-commit`; an existing hook is
appended to, never overwritten — re-running is a no-op):

```sh
ledger init                 # hook only
ledger init --with-config   # also scaffolds .ledger.json + its schema
```

Record work (normally fired by an editor plugin, not by hand):

```sh
ledger heartbeat --file src/api.rs          # a read/navigation event
ledger heartbeat --file src/api.rs --write  # a write event
```

See where the time went:

```sh
ledger report
ledger report --project acme-api --since 2026-07-01 --until 2026-07-31
ledger report --idle-threshold-minutes 30
```

Heartbeats collapse into sessions: a gap longer than the idle threshold
(default 15 minutes), or a switch of project/branch, starts a new session.
`--since`/`--until` are inclusive calendar days in local time.

One-line status for the repo you're in (`--json` is what statusline
integrations consume; outside a git repo it exits 0 with null fields):

```sh
ledger status          # ledger · main · 2h 13m today
ledger status --json
```

## Neovim

The repo doubles as a neovim plugin (`lua/` + `plugin/` at the root):
automatic heartbeats while you edit, `:Ledger {status|enable|disable}`,
`:checkhealth ledger`, and a statusline component. Requires nvim ≥ 0.10
and the `ledger` binary on `PATH` (or set `opts.cmd` to an absolute path).

```lua
-- any plugin manager; e.g. a vim.pack-style spec
{
	src = "https://github.com/fmaplabs/ledger",
	config = function()
		require("ledger").setup({
			-- cmd = "ledger",           -- binary name or absolute path
			-- heartbeat_interval = 120,    -- seconds, per-file throttle
			-- status_refresh_interval = 30,
			-- exclude_filetypes = {},
		})
	end,
}
```

Statusline (lualine shown; `get()`/`has()` are plain functions):

```lua
{
	function() return require("ledger.lualine").get() end,
	cond = function()
		local ok, ft = pcall(require, "ledger.lualine")
		return ok and ft.has()
	end,
}
```

See [docs/stages/13-nvim-plugin.md](docs/stages/13-nvim-plugin.md) for the
design; `tests/nvim/run.sh` runs the plugin's headless smoke tests.

## Per-repo config (`.ledger.json`, optional)

```json
{
  "$schema": "./.ledger.schema.json",
  "project": "acme-api",
  "idleThresholdMinutes": 15
}
```

- `project` — overrides the project name (default: the repo directory's name;
  the branch name is used as the task).
- `idleThresholdMinutes` — session-split threshold. Precedence: CLI flag >
  `.ledger.json` > default (15).

`ledger schema` prints the JSON Schema for this file (the same one
`init --with-config` writes next to it, which `$schema`-aware editors pick up
for validation and completion).

## Never fail loudly

`heartbeat` and `hook-commit` are designed to be safe to call from an editor
or a git hook: they always exit 0 and print nothing, no matter what goes
wrong (not in a repo, malformed config, locked database, even an internal
panic). Failures are appended to `~/.ledger/error.log` instead — look
there if heartbeats seem to be disappearing.

`LEDGER_HOME` overrides the `~/.ledger` data directory (used by the
integration tests; handy for keeping scratch experiments out of your real
data).
