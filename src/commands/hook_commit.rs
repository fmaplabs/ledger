use std::env;

use anyhow::{Context, Result};

use crate::cloud::{self, Timeouts};
use crate::{db, errors, git, paths, project, settings};

/// Called by the installed post-commit hook: stamp HEAD's sha onto every
/// still-untagged heartbeat for this project/task. Runs under
/// `run_silently` so a broken ledger install can never disturb a commit.
pub fn run() {
    errors::run_silently(tag_heartbeats_with_head);
}

fn tag_heartbeats_with_head() -> Result<()> {
    let cwd = env::current_dir().context("resolving current directory")?;
    let identity = project::resolve_identity(&cwd)?;
    let sha = git::head_sha(&cwd)?;

    let home = paths::ensure_ledger_home()?;
    let settings = settings::load_or_init(&home)?;
    let mut conn =
        db::open_db(&paths::db_path(&home), &settings.device_id).context("opening heartbeat db")?;
    db::tag_untagged_heartbeats(
        &conn,
        &identity.project,
        &identity.task,
        &sha,
        &settings.device_id,
    )
    .context("tagging heartbeats")?;

    // Best-effort push with tight timeouts. Failures land in the error log
    // without touching the already-successful tagging above; logged out is
    // a silent no-op (sync_all returns Ok(None)).
    if let Err(e) = cloud::sync_all(&mut conn, &home, &settings, Timeouts::hook(), true) {
        errors::log_error(&format!("post-commit sync push failed: {e:#}"));
    }
    Ok(())
}
