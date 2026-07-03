use anyhow::Result;

use crate::{paths, settings};

/// `ledger logout`: forget the stored tokens. Local heartbeat data is
/// untouched — sync just stops until the next login.
pub fn run() -> Result<()> {
    let home = paths::ensure_ledger_home()?;
    settings::delete_credentials(&home)?;
    println!("Logged out.");
    Ok(())
}
