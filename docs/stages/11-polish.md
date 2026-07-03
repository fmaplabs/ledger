# Stage 11: Polish

Manual verification pass + a short README. No new Rust concepts — this is
about proving the whole thing actually works together.

## Tasks

- [x] Manual smoke test in a real (non-scratch) repo:
  - `ledger init --with-config` → confirm `.git/hooks/post-commit`,
    `.ledger.json`, `.ledger.schema.json` all exist
  - a few `ledger heartbeat` calls, then a `git commit`
  - `ledger report` shows hours, with the commit hash attached to the right
    session
  - re-run `ledger init` and confirm it detects the existing hook instead
    of clobbering it
- [x] Confirm `ledger schema`'s output actually validates a scaffolded
  `.ledger.json` — opening the file in an editor that understands
  `$schema` (VS Code does this natively) is the easiest check
- [x] Confirm the "never fail loudly" property directly:
  - `ledger heartbeat` outside any git repo → exits 0, no crash, no row
    inserted
  - `ledger heartbeat` inside a repo with a deliberately malformed
    `.ledger.json` → exits 0, no crash, a warning appended to the error log
- [x] Write a short README: install (`cargo install --path .`, or build +
  copy the binary onto `PATH`), `ledger init` usage, `ledger
  heartbeat`/`report` usage

## Resources

- [VS Code — JSON Schemas and Settings](https://code.visualstudio.com/docs/languages/json#_json-schemas-and-settings) — how `$schema` gets picked up automatically
- [`cargo install` reference](https://doc.rust-lang.org/cargo/commands/cargo-install.html)
