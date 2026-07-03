use std::env;

use anyhow::{Context, Result};
use chrono::Utc;

use crate::{db, errors, paths, project, settings};

/// Record one heartbeat for the repo containing the current directory.
/// Runs under `run_silently`: outside a repo (or on any other failure) this
/// is a no-op that exits 0, so editor plugins can fire it unconditionally.
pub fn run(file: Option<String>, is_write: bool) {
    errors::run_silently(|| record_heartbeat(file.as_deref(), is_write));
}

fn record_heartbeat(file: Option<&str>, is_write: bool) -> Result<()> {
    let cwd = env::current_dir().context("resolving current directory")?;
    let identity = project::resolve_identity(&cwd)?;

    let home = paths::ensure_ledger_home()?;
    let settings = settings::load_or_init(&home)?;
    let conn =
        db::open_db(&paths::db_path(&home), &settings.device_id).context("opening heartbeat db")?;
    db::insert_heartbeat(
        &conn,
        Utc::now().timestamp_millis(),
        &identity.project,
        &identity.task,
        file,
        is_write,
        &uuid::Uuid::new_v4().to_string(),
        &settings.device_id,
    )
    .context("inserting heartbeat")?;
    Ok(())
}
