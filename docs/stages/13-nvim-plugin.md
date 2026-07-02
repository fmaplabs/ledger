# Stage 13: Neovim plugin (foldtime.nvim)

Requirement #2 from `docs/foldTime.md`: the editor side of the heartbeat
model. The plugin lives at the repo root (`lua/` + `plugin/`, fzf-style), so
the repo itself is installable as a neovim plugin straight from GitHub — no
separate repository, and the plugin version always matches the CLI it was
written against.

**Division of labor**: the plugin never touches SQLite, config files, or
cloud sync. It spawns `foldtime heartbeat --file <path> [--write]`
(fire-and-forget, always exits 0) with the **buffer's directory** as cwd, and
the CLI resolves project/task from that repo exactly as it does for the git
hook. The statusline reads one new machine-readable command, `foldtime
status --json`, the same way.

## Tasks

- [x] `src/dates.rs` — extract the day-parsing / DST-safe local-midnight
  helpers out of `report.rs` (pure refactor; `status` needs them too)
- [x] `foldtime status [--json]` — identity from cwd (like `heartbeat`),
  today's tracked time (local midnight → now, collapsed through the same
  session logic as `report`), last heartbeat, idle threshold. Outside a git
  repo: exit 0 with `project`/`task`/`lastHeartbeatMs` null — one code path
  for the consumer. Human mode prints `foldTime · main · 2h 13m today`
- [x] `tests/common/mod.rs` — the temp-repo + `FOLDTIME_HOME` harness shared
  by the init/hook and status integration suites; `tests/integration_status.rs`
  pins the JSON contract field by field
- [x] `lua/foldtime/cli.lua` — pcall-wrapped `vim.system` spawns
  (`vim.system` throws synchronously on ENOENT); a spawn failure notifies
  once, is memoized for `:checkhealth`, and never reaches an autocmd
- [x] `lua/foldtime/heartbeat.lua` — guard chain (cheapest first: buftype,
  unnamed, `scheme://` buffers, `exclude_filetypes`, vanished dirname, and a
  memoized not-in-a-git-repo check — the CLI would no-op anyway, but it logs
  the failure, and auto-fired heartbeats would slowly fill
  `~/.foldtime/error.log`) and a per-file throttle: activity sends at most
  every `heartbeat_interval` (120s), writes always send and refresh the
  window
- [x] `lua/foldtime/init.lua` — `setup()` (idempotent: augroup with
  `clear = true`), activity autocmds (`BufEnter`, `CursorMoved(I)`,
  `TextChanged(I)`, `BufWritePost`), dormant-with-one-warning when the
  binary is missing
- [x] `plugin/foldtime.lua` — `:FoldTime {status|enable|disable}` only;
  lazy-requires and self-setups so the command works before any config ran
- [x] `lua/foldtime/status.lua` — cached `status --json`: repeating uv timer
  (`status_refresh_interval`, 30s), single in-flight guard, refresh pokes
  after writes (deferred 1s so the row lands first) and on BufEnter when the
  buffer's directory changed; `get()` is a pure table read
- [x] `lua/foldtime/lualine.lua` — `get()` (`󰔛 2h 13m`, `󰔛 off` when
  disabled) and `has()` (hides the segment outside git repos or without the
  binary); plain functions, no lualine dependency
- [x] `lua/foldtime/health.lua` — `:checkhealth foldtime`: nvim ≥ 0.10,
  binary on PATH, a live `status --json` handshake (catches a binary too old
  to know `status`), repo identity, intervals, last send, memoized spawn
  errors
- [x] `tests/nvim/` — headless smoke tests with a bash shim standing in for
  the binary (logs `cwd|argv`, cans the status JSON): throttle, `--write`
  bypass, per-file windows, buffer guards, enable/disable, statusline cache.
  `tests/nvim/run.sh`, no plenary
- [x] dots integration — unpack spec (`src = ".../foldTime"`) + lualine
  `lualine_x` component with the require deferred to render time

## Why 120s between heartbeats

Sessions only split on gaps longer than the idle threshold (15 min) and
`report` floors to minutes, so heartbeating more often than every couple of
minutes buys no accuracy — it just multiplies process spawns and DB rows.
120s (the wakatime convention) keeps an active session unbroken at at most
one spawn per file per 2 minutes; the throttle itself is one table lookup
and a monotonic-clock compare, cheap enough for `CursorMoved`. The known
trade-off: a session's last partial interval and one-heartbeat sessions
undercount — inherent to the heartbeat model, tunable via
`heartbeat_interval`.

## PATH in GUI-launched neovim

GUI editors often don't inherit a login shell's PATH, so `~/.cargo/bin` may
be missing and the plugin goes dormant (with one warning). `opts.cmd`
accepts an absolute path, and `:checkhealth foldtime` diagnoses exactly
this. The compiled-in endpoint rationale from stage 12 applies here too:
nothing in the plugin depends on shell profile state.

## Development

- `cargo test` — includes the `status` units and integration suite
- `tests/nvim/run.sh` — headless plugin smoke tests (needs nvim ≥ 0.10 on
  PATH, no Rust build)

## Resources

- [`:h vim.system()`](https://neovim.io/doc/user/lua.html#vim.system()) — the
  async spawn API (nvim 0.10+), and why ENOENT needs a pcall
- [`:h health-dev`](https://neovim.io/doc/user/health.html#health-dev) — how
  `lua/foldtime/health.lua` gets discovered by `:checkhealth`
- [lualine components](https://github.com/nvim-lualine/lualine.nvim#custom-components)
- [wakatime heartbeat model](https://wakatime.com/developers#heartbeats) —
  prior art for the interval + write-bypass convention
