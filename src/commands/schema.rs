use anyhow::Result;

use crate::config::ProjectConfig;

/// Print the JSON Schema for `.ledger.json` to stdout. Generated from the
/// same struct serde parses, so the schema can't drift from the parser.
pub fn run() -> Result<()> {
    let schema = schemars::schema_for!(ProjectConfig);
    println!("{}", serde_json::to_string_pretty(&schema)?);
    Ok(())
}
