use anyhow::{Context, Result, bail};

use crate::cloud::{self, Timeouts};
use crate::{db, paths, settings};

/// `ledger sync`: loud two-way sync (or push-only with `--push-only`).
pub fn run(push_only: bool) -> Result<()> {
    let home = paths::ensure_ledger_home()?;
    let settings = settings::load_or_init(&home)?;
    if settings::load_credentials(&home)?.is_none() {
        bail!("not logged in — run `ledger login`");
    }

    let mut conn =
        db::open_db(&paths::db_path(&home), &settings.device_id).context("opening heartbeat db")?;
    println!("device: {} ({})", settings.device_name, settings.device_id);

    let outcome = cloud::sync_all(&mut conn, &home, &settings, Timeouts::interactive(), push_only)?
        // Credentials were checked above; racing a concurrent logout here is
        // indistinguishable from not being logged in at all.
        .context("not logged in — run `ledger login`")?;
    println!(
        "pushed {} heartbeat(s), pulled {}",
        outcome.pushed, outcome.pulled
    );
    Ok(())
}
