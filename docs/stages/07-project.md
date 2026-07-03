# Stage 7: `project.rs` — identity resolution

Combine `git.rs` + `config.rs` into the one function every command actually
calls: "what project/task am I in, right now?"

## Concepts

- Composing modules together
- Chaining multiple `Result`-returning calls
- More `?` practice

## Tasks

- [x] Define an `Identity` struct: `project: String`, `task: String`,
  `repo_root: PathBuf`
- [x] `resolve_identity(cwd: &Path) -> Result<Identity>`:
  1. `git::repo_root(cwd)` — propagate failure if not in a repo
  2. `git::current_branch(cwd)` (or the detached-HEAD representation from
     Stage 5) for `task`
  3. `config::load_config(&repo_root)` for an optional `project` override
  4. Resolve `project`: config override if present, else the repo root's
     directory name
- [x] Decide where "not in a git repo" surfaces as behavior — `project.rs`
  itself should just propagate the `Err`; the *silent no-op* behavior for
  `heartbeat` is a `commands/heartbeat.rs` + `errors.rs` concern (Stages 8–9),
  not this file's job
- [x] Unit tests: with a `.ledger.json` override present (project name
  differs from dirname); without one (falls back to dirname); a non-repo
  `cwd` returns an `Err`

## Resources

- [The Rust Book ch. 9.2 — Recoverable Errors with `Result`](https://doc.rust-lang.org/book/ch09-02-recoverable-errors-with-result.html) — same chapter as Stage 3, now applied across module boundaries
- [`std::path::Path::file_name`](https://doc.rust-lang.org/std/path/struct.Path.html#method.file_name) — deriving the default project name from the repo root's dirname
