# Stage 3: `paths.rs` — filesystem locations

First stage with real I/O: resolving and creating `~/.ledger` and the paths
inside it.

## Concepts

- `Result<T, E>` and the `?` operator
- `std::fs`
- `PathBuf` / `Path`
- The `dirs` crate

## Tasks

- [x] Resolve the home directory via `dirs::home_dir()` and build the
  `~/.ledger` path
- [x] Ensure `~/.ledger` exists, creating it if necessary
  (`fs::create_dir_all`)
- [x] Expose the DB file path (`~/.ledger/ledger.db`)
- [x] Expose the error-log file path (e.g. `~/.ledger/error.log`)
- [x] Decide the error type for "no home directory could be resolved" — this
  is a real (if rare) failure mode, not a `panic!`/`unwrap()` case
- [x] **Forward-looking decision**: should these paths be overridable via an
  env var (e.g. `LEDGER_HOME`)? Stage 10's integration test will run the
  real compiled binary end-to-end and needs to avoid writing into your actual
  `~/.ledger` during tests — decide and implement the override now while
  you're already in this file, rather than retrofitting it later
- [x] Unit tests: pure path-joining logic tested without touching the real
  filesystem where possible; directory-creation behavior tested against a
  `tempfile::tempdir()` (or the env var override, if you add one)

## Resources

- [The Rust Book ch. 9 — Error Handling](https://doc.rust-lang.org/book/ch09-00-error-handling.html)
- [The Rust Book ch. 9.2 — Recoverable Errors with `Result`](https://doc.rust-lang.org/book/ch09-02-recoverable-errors-with-result.html)
- [`std::path::PathBuf`](https://doc.rust-lang.org/std/path/struct.PathBuf.html)
- [`std::path::Path`](https://doc.rust-lang.org/std/path/struct.Path.html)
- [`std::fs` module](https://doc.rust-lang.org/std/fs/index.html)
- [`dirs` crate docs](https://docs.rs/dirs/latest/dirs/)
- [`dirs` crate repo](https://github.com/dirs-dev/dirs-rs) — has the per-platform path table
- [`std::env::var`](https://doc.rust-lang.org/std/env/fn.var.html) — for the optional override
