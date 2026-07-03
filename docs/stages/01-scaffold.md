# Stage 1: Scaffold

Get a lib+bin Cargo project building end to end, with a full `clap` command
surface that only prints stubs — no real logic yet.

## Concepts

- Cargo project layout: `src/main.rs` (binary crate) vs `src/lib.rs` (library
  crate) in one package
- Modules: `mod` vs `pub mod`
- `clap`'s derive macros (`Parser`, `Subcommand`) and how field types/attributes
  map to CLI shape
- Enums with per-variant data, and `match`

## Tasks

- [x] Rename the package in `Cargo.toml` from `ledger` to `ledger` (binary
  name should match the package name; mixed-case package names also trigger a
  Cargo lint)
- [x] Add `src/lib.rs` with `pub mod cli;`
- [x] Add `src/cli.rs`: `#[derive(Parser)] pub struct Cli` wrapping a
  `#[derive(Subcommand)] pub enum Commands` with variants `Init`, `Heartbeat`,
  `HookCommit`, `Report`, `Schema`
- [x] Give `Cli`'s `command` field `pub` visibility (struct-level `pub` does
  **not** make fields public — each field needs its own `pub`)
- [x] Give each named-option field `#[arg(long)]` — without it, clap derive
  defaults **every** field to a positional argument regardless of type, and a
  positional `bool` field is a contradiction clap rejects at runtime (not
  compile time)
  - `Init { #[arg(long)] with_config: bool }`
  - `Heartbeat { #[arg(long)] file: Option<String>, #[arg(long)] write: bool }`
  - `Report { #[arg(long)] project: Option<String>, #[arg(long)] since: Option<String>, #[arg(long)] until:
  Option<String> }`
  - `HookCommit`, `Schema` — no fields, use bare unit variants (`HookCommit,`
    not `HookCommit {},`)
- [x] Run `cargo add` for the full dependency table: `clap --features derive`,
  `rusqlite --features bundled`, `serde --features derive`, `serde_json`,
  `schemars --features derive`, `chrono`, `dirs`, `anyhow`, `tempfile --dev`
- [x] Rewrite `main.rs`: call `Cli::parse()`, then `match cli.command { ... }`
  with a `println!` stub per arm showing what it received
- [x] Verify: `cargo build` succeeds; `cargo run -- init --with-config`,
  `cargo run -- heartbeat --file foo.rs --write`, `cargo run -- report
  --project X --since 2026-01-01` etc. each print something sensible, and
  `cargo run -- init --help` shows `--with-config` as an actual option (not a
  positional arg)

## Known environment gotcha (already fixed)

`cargo add rusqlite` picks the latest `rusqlite`, which as of this writing
pulls in `libsqlite3-sys 0.38.x` — a version whose build script uses an
unstable `cfg_select!` macro and fails to compile on both stable and nightly
Rust. `Cargo.toml` pins `rusqlite = "0.39.0"` (resolves to the known-good
`libsqlite3-sys 0.37.0`) to work around it. If a future `cargo update` ever
reintroduces this, check [rusqlite's issue tracker](https://github.com/rusqlite/rusqlite/issues)
before assuming it's your code.

## Resources

- [The Rust Book ch. 7 — Managing Growing Projects with Packages, Crates, and
Modules](https://doc.rust-lang.org/book/ch07-00-managing-growing-projects-with-packages-crates-and-modules.html)
- [Cargo Book — Package Layout](https://doc.rust-lang.org/cargo/guide/project-layout.html)
- [Cargo Book — Manifest Format (`Cargo.toml`)](https://doc.rust-lang.org/cargo/reference/manifest.html)
- [`cargo add` reference](https://doc.rust-lang.org/cargo/commands/cargo-add.html)
- [clap derive tutorial](https://docs.rs/clap/latest/clap/_derive/index.html)
- [clap examples (runnable subcommand samples)](https://github.com/clap-rs/clap/tree/master/examples)
- [The Rust Book ch. 6 — Enums and Pattern
Matching](https://doc.rust-lang.org/book/ch06-00-enums-and-pattern-matching.html)
- [The Rust Book Appendix C — Derivable Traits](https://doc.rust-lang.org/book/appendix-03-derivable-traits.html)
(background on what `#[derive(...)]` does generally)
