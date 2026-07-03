//! Machine-readable "where am I and how much have I worked today?" — built
//! for the editor plugin's statusline, which spawns this with the buffer's
//! directory as cwd and parses one JSON object.

use std::env;

use anyhow::{Context, Result};
use chrono::Local;
use serde::Serialize;

use crate::project::Identity;
use crate::sessions::Heartbeat;
use crate::{config, dates, db, paths, project, sessions, settings};

use super::report::format_duration_ms;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusOutput {
    project: Option<String>,
    task: Option<String>,
    tracked_today_ms: i64,
    last_heartbeat_ms: Option<i64>,
    idle_threshold_minutes: u32,
}

pub fn run(json: bool) -> Result<()> {
    let cwd = env::current_dir().context("resolving current directory")?;
    // Not being in a repo is a normal answer here (nulls, exit 0), not an
    // error — the statusline polls this from arbitrary buffers.
    let output = match project::resolve_identity(&cwd) {
        Ok(identity) => status_for(identity)?,
        Err(_) => outside_repo(),
    };

    if json {
        println!("{}", serde_json::to_string(&output)?);
    } else {
        println!("{}", output.human());
    }
    Ok(())
}

fn status_for(identity: Identity) -> Result<StatusOutput> {
    let home = paths::ensure_ledger_home()?;
    let settings = settings::load_or_init(&home)?;
    let conn =
        db::open_db(&paths::db_path(&home), &settings.device_id).context("opening heartbeat db")?;

    let today_start = dates::local_day_start_ms(Local::now().date_naive())?;
    let heartbeats =
        db::query_heartbeats(&conn, Some(&identity.project), None, Some(today_start), None)
            .context("querying heartbeats")?;

    let repo_config = config::load_config(&identity.repo_root);
    let threshold_min = config::resolve_idle_threshold_minutes(None, &repo_config);

    Ok(compute(identity, &heartbeats, threshold_min))
}

fn outside_repo() -> StatusOutput {
    StatusOutput {
        project: None,
        task: None,
        tracked_today_ms: 0,
        last_heartbeat_ms: None,
        idle_threshold_minutes: config::DEFAULT_IDLE_THRESHOLD_MINUTES,
    }
}

fn compute(identity: Identity, heartbeats: &[Heartbeat], threshold_min: u32) -> StatusOutput {
    let sessions =
        sessions::collapse_into_sessions(heartbeats, i64::from(threshold_min) * 60_000);
    StatusOutput {
        project: Some(identity.project),
        task: Some(identity.task),
        tracked_today_ms: sessions.iter().map(|s| s.end - s.start).sum(),
        last_heartbeat_ms: heartbeats.last().map(|hb| hb.ts),
        idle_threshold_minutes: threshold_min,
    }
}

impl StatusOutput {
    fn human(&self) -> String {
        match &self.project {
            Some(project) => format!(
                "{project} · {} · {} today",
                self.task.as_deref().unwrap_or("?"),
                format_duration_ms(self.tracked_today_ms)
            ),
            None => "not in a git repo".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn identity() -> Identity {
        Identity {
            project: "foo".to_string(),
            task: "main".to_string(),
            repo_root: PathBuf::from("/tmp/foo"),
        }
    }

    fn hb(ts: i64) -> Heartbeat {
        Heartbeat {
            ts,
            project: "foo".to_string(),
            task: "main".to_string(),
            commit_hash: None,
        }
    }

    #[test]
    fn no_heartbeats_today_is_zero_with_no_last() {
        let out = compute(identity(), &[], 15);
        assert_eq!(out.tracked_today_ms, 0);
        assert_eq!(out.last_heartbeat_ms, None);
        assert_eq!(out.project.as_deref(), Some("foo"));
        assert_eq!(out.task.as_deref(), Some("main"));
        assert_eq!(out.idle_threshold_minutes, 15);
    }

    #[test]
    fn single_heartbeat_tracks_zero_but_reports_last() {
        let out = compute(identity(), &[hb(1_000)], 15);
        assert_eq!(out.tracked_today_ms, 0); // zero-duration session
        assert_eq!(out.last_heartbeat_ms, Some(1_000));
    }

    #[test]
    fn sessions_sum_and_idle_gaps_do_not_count() {
        let minute = 60_000;
        // session one: 0 → 10min; 20min idle gap; session two: 30min → 35min
        let hbs = [hb(0), hb(10 * minute), hb(30 * minute), hb(35 * minute)];
        let out = compute(identity(), &hbs, 15);
        assert_eq!(out.tracked_today_ms, 15 * minute);
        assert_eq!(out.last_heartbeat_ms, Some(35 * minute));
    }

    #[test]
    fn json_shape_is_camel_case_with_nulls_outside_a_repo() {
        let json = serde_json::to_value(outside_repo()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "project": null,
                "task": null,
                "trackedTodayMs": 0,
                "lastHeartbeatMs": null,
                "idleThresholdMinutes": 15,
            })
        );
    }

    #[test]
    fn human_line_reads_project_task_and_time() {
        let out = compute(identity(), &[hb(0), hb(8_100_000)], 200);
        assert_eq!(out.human(), "foo · main · 2h 15m today");
        assert_eq!(outside_repo().human(), "not in a git repo");
    }
}
