# Stage 9: `cli.rs` + `commands/` — real implementations

Replace the Stage 1 `println!` stubs with the real thing. Build in this
order — `heartbeat` → `hook-commit` → `init` → `schema` → `report` — since
`report` depends on everything else already being solid.

## Concepts

- Assembling all prior modules into a full application
- File I/O for hook installation (read-detect-append vs. overwrite)
- Formatting output

## Tasks

- [x] `commands/heartbeat.rs`: `project::resolve_identity`, `db::open_db`,
  `db::insert_heartbeat`, all wrapped in `errors::run_silently`
- [x] `commands/hook_commit.rs`: resolve identity, `git::head_sha`,
  `db::tag_untagged_heartbeats`, wrapped in `run_silently`
- [x] `commands/init.rs`:
  - read `.git/hooks/post-commit` if it exists; if it already invokes
    `ledger hook-commit`, no-op; if it exists but doesn't, append rather
    than overwrite (or warn and refuse — decide which)
  - if it doesn't exist, write a small shell script that calls `ledger
    hook-commit`, then mark it executable
    (`std::os::unix::fs::PermissionsExt::set_permissions`)
  - `--with-config`: scaffold `.ledger.json` and `.ledger.schema.json` at
    the repo root, with `.ledger.json`'s `$schema` field pointing at the
    sibling schema file by relative path
- [x] `commands/schema.rs`: `schemars::schema_for!(ProjectConfig)`, pretty-print
  as JSON to stdout
- [x] `commands/report.rs`: `db::query_heartbeats`,
  `sessions::collapse_into_sessions`, print a plain-text table (project /
  task / duration / commit count)
- [x] Wire `main.rs`'s `match` arms to call these instead of printing stubs

## Resources

- [The Rust Book ch. 12 — An I/O Project: Building a Command Line Program](https://doc.rust-lang.org/book/ch12-00-an-io-project.html) — closest analogue in the Book to what this whole stage does
- [`std::fs::OpenOptions`](https://doc.rust-lang.org/std/fs/struct.OpenOptions.html) — append vs. overwrite when installing the hook
- [`std::os::unix::fs::PermissionsExt`](https://doc.rust-lang.org/std/os/unix/fs/trait.PermissionsExt.html) — `chmod +x` on the hook file
- [`githooks` — the `post-commit` contract](https://git-scm.com/docs/githooks)
- [`schemars::schema_for!` macro](https://docs.rs/schemars/latest/schemars/macro.schema_for.html)
- [clap derive tutorial](https://docs.rs/clap/latest/clap/_derive/index.html) — re-read once you're actually dispatching on the full enum
