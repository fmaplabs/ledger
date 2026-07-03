# Stage 6: `config.rs` — `.ledger.json`

Optional per-repo config, loaded tolerantly (never a hard failure) and
schema-generated so the schema can't drift from the parser.

## Concepts

- Derive macros: `Serialize`, `Deserialize`, `JsonSchema`
- `Option<T>` field defaults
- JSON (de)serialization

## Tasks

- [x] Define `ProjectConfig` deriving `Serialize, Deserialize, JsonSchema`:
  `project: Option<String>`, `idle_threshold_minutes: Option<u32>` (field
  names in JSON should be `camelCase` per the plan's example — check
  `#[serde(rename_all = "camelCase")]`)
- [x] `DEFAULT_IDLE_THRESHOLD_MINUTES: u32 = 15` constant
- [x] `load_config(repo_root: &Path) -> ProjectConfig` — tolerant: file
  missing → defaults; file present but malformed JSON → defaults **and** a
  warning logged (wire this to `errors.rs` once Stage 8 exists; until then,
  a `TODO` or a temporary `eprintln!` is fine)
- [x] Idle-threshold resolution helper implementing the precedence from the
  plan: `cli_flag.or(project_config.idle_threshold_minutes).unwrap_or(DEFAULT_IDLE_THRESHOLD_MINUTES)`
- [x] Unit tests: valid config round-trips through `serde_json`; missing file
  → defaults; malformed JSON → defaults

## Resources

- [The Serde Book](https://serde.rs/) — start here, it's short and this is the best serde reference that exists
- [Serde field attributes](https://serde.rs/field-attrs.html) — `#[serde(default)]`, `#[serde(rename_all = "camelCase")]`
- [`serde_json` docs.rs](https://docs.rs/serde_json/latest/serde_json/)
- [`schemars` docs.rs](https://docs.rs/schemars/latest/schemars/)
- [`schemars` GitHub repo](https://github.com/GREsau/schemars)
- [The Rust Book Appendix C — Derivable Traits](https://doc.rust-lang.org/book/appendix-03-derivable-traits.html)
