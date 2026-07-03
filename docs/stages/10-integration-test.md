# Stage 10: `tests/integration_init_hook.rs`

Test the compiled binary as a black box: real temp repo, real `init`, real
`git commit` firing the real installed hook, real DB assertions.

## Concepts

- Rust integration tests (`tests/` directory) vs. inline `#[cfg(test)]` modules
- Testing a compiled binary as a black box
- Environment variables Cargo provides to tests

## Tasks

- [x] Create `tests/integration_init_hook.rs`
- [x] `tempfile::tempdir()` + shelled `git init` to build a throwaway repo
- [x] Locate the compiled binary via `env!("CARGO_BIN_EXE_ledger")` — Cargo
  sets this automatically for integration tests, no `assert_cmd` needed
- [x] Run `ledger init` (and `--with-config`) against the throwaway repo via
  `std::process::Command`
- [x] Assert `.git/hooks/post-commit` exists and is executable
- [x] Make a real `git commit` in the throwaway repo — set `GIT_AUTHOR_*` /
  `GIT_COMMITTER_*` env vars on the `Command` so the test doesn't depend on
  your global git config being present
- [x] Point the binary at a temp DB rather than your real `~/.ledger` — this
  is why Stage 3 flagged an env var override; set it on the `Command` you use
  to invoke `ledger`
- [x] Assert, via a direct `rusqlite::Connection::open` on that temp DB, that
  heartbeats got tagged with the commit's SHA after the hook fired

## Resources

- [The Rust Book ch. 11.3 — Test Organization](https://doc.rust-lang.org/book/ch11-03-test-organization.html)
- [Cargo Book — Environment Variables Cargo Sets for Crates](https://doc.rust-lang.org/cargo/reference/environment-variables.html) — `CARGO_BIN_EXE_<name>`
- [`tempfile` docs.rs](https://docs.rs/tempfile/latest/tempfile/)
- [`std::process::Command`](https://doc.rust-lang.org/std/process/struct.Command.html) — now running your own binary instead of `git`
