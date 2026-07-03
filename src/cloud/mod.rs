//! Everything that talks to the network lives behind this module: the
//! WorkOS device-auth flow, the blocking Convex HTTP client, and the
//! push/pull sync engine.
//!
//! Sync model: every heartbeat row is owned by the device that created it.
//! Only the owner pushes a row; everyone else pulls read-only copies —
//! conflicts are impossible by construction. Push sends local `dirty` rows;
//! pull follows a cursor over the server-side `syncedAt` timestamp (set by
//! the push mutation, never by a client clock).

pub mod auth;
pub mod convex;

use std::path::Path;

use anyhow::{Context, Result, bail};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::{self, RemoteRow, SyncRow};
use crate::settings::{self, Settings};
pub use convex::Timeouts;
use convex::{ApiError, ConvexClient};

const BATCH_SIZE: usize = 500;

#[derive(Debug, PartialEq)]
pub struct SyncOutcome {
    pub pushed: usize,
    pub pulled: usize,
}

/// Push this device's dirty rows, then (unless `push_only`) pull everyone
/// else's new rows. Returns `None` when not logged in — the hook path treats
/// that as a silent no-op.
pub fn sync_all(
    conn: &mut Connection,
    ledger_home: &Path,
    settings: &Settings,
    timeouts: Timeouts,
    push_only: bool,
) -> Result<Option<SyncOutcome>> {
    let Some(mut token) = auth::get_valid_token(settings, ledger_home, timeouts)? else {
        return Ok(None);
    };
    let client = ConvexClient::new(&settings.convex_url()?, timeouts);

    let pushed = push_dirty_rows(conn, ledger_home, settings, timeouts, &client, &mut token)?;
    let pulled = if push_only {
        0
    } else {
        pull_new_rows(conn, ledger_home, settings, timeouts, &client, &mut token)?
    };
    Ok(Some(SyncOutcome { pushed, pulled }))
}

fn push_dirty_rows(
    conn: &mut Connection,
    ledger_home: &Path,
    settings: &Settings,
    timeouts: Timeouts,
    client: &ConvexClient,
    token: &mut String,
) -> Result<usize> {
    let mut pushed = 0;
    loop {
        let batch = db::select_dirty_batch(conn, &settings.device_id, BATCH_SIZE)?;
        if batch.is_empty() {
            return Ok(pushed);
        }
        let args = json!({
            "deviceId": settings.device_id,
            "deviceName": settings.device_name,
            "rows": batch.iter().map(WireRow::from).collect::<Vec<_>>(),
        });
        // Server-side upsert by (userId, uuid) makes retrying a batch whose
        // mark_clean never ran harmless.
        with_auth(settings, ledger_home, timeouts, token, |t| {
            client.mutation(t, "sync:push", args.clone())
        })
        .context("pushing heartbeats")?;
        pushed += batch.len();
        // A row re-tagged mid-push stays dirty (and re-selects); if nothing
        // cleaned we'd re-push the same batch forever — leave it for the
        // next sync instead.
        if db::mark_clean(conn, &batch)? == 0 {
            return Ok(pushed);
        }
    }
}

fn pull_new_rows(
    conn: &mut Connection,
    ledger_home: &Path,
    settings: &Settings,
    timeouts: Timeouts,
    client: &ConvexClient,
    token: &mut String,
) -> Result<usize> {
    let mut pulled = 0;
    loop {
        let cursor = db::get_pull_cursor(conn)?;
        let args = json!({
            "cursor": cursor,
            "limit": BATCH_SIZE,
            "excludeDeviceId": settings.device_id,
        });
        let value = with_auth(settings, ledger_home, timeouts, token, |t| {
            client.query(t, "sync:pull", args.clone())
        })
        .context("pulling heartbeats")?;
        let page: PullPage =
            serde_json::from_value(value).context("parsing sync:pull response")?;

        let next_cursor = page.next_cursor as i64;
        if !page.is_done && next_cursor <= cursor {
            // Server contract violation; without progress this would loop
            // forever, so refuse instead.
            bail!("sync:pull did not advance the cursor ({cursor})");
        }
        let rows: Vec<RemoteRow> = page.rows.into_iter().map(PulledWireRow::into_remote).collect();
        // Rows and cursor land in one transaction: a crash between pages
        // resumes exactly where the last committed page ended.
        db::apply_pulled_rows(conn, &rows, next_cursor)?;
        pulled += rows.len();
        if page.is_done {
            return Ok(pulled);
        }
    }
}

/// Run a Convex call; on HTTP 401 refresh the token (persisted by
/// `auth::refresh` before it returns) and retry exactly once.
fn with_auth(
    settings: &Settings,
    ledger_home: &Path,
    timeouts: Timeouts,
    token: &mut String,
    mut call: impl FnMut(&str) -> Result<Value, ApiError>,
) -> Result<Value> {
    match call(token) {
        Ok(value) => Ok(value),
        Err(ApiError::Unauthorized) => {
            let credentials = settings::load_credentials(ledger_home)?
                .context("access token rejected and no stored credentials to refresh")?;
            *token = auth::refresh(settings, ledger_home, &credentials.refresh_token, timeouts)?
                .access_token;
            call(token).map_err(anyhow::Error::from)
        }
        Err(other) => Err(other.into()),
    }
}

/// Push wire shape. Convex's `v.optional(...)` means "key absent", not
/// "value null" — None fields must be skipped, not serialized as null.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireRow<'a> {
    uuid: &'a str,
    ts: i64,
    project: &'a str,
    task: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<&'a str>,
    is_write: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit_hash: Option<&'a str>,
}

impl<'a> From<&'a SyncRow> for WireRow<'a> {
    fn from(row: &'a SyncRow) -> Self {
        WireRow {
            uuid: &row.uuid,
            ts: row.ts,
            project: &row.project,
            task: &row.task,
            file: row.file.as_deref(),
            is_write: row.is_write,
            commit_hash: row.commit_hash.as_deref(),
        }
    }
}

/// Pull wire shape. Convex numbers are float64 — integral in practice
/// (Date.now() / timestamp_millis), so they arrive as f64 and get cast.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullPage {
    rows: Vec<PulledWireRow>,
    next_cursor: f64,
    is_done: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PulledWireRow {
    uuid: String,
    ts: f64,
    project: String,
    task: String,
    #[serde(default)]
    file: Option<String>,
    is_write: bool,
    #[serde(default)]
    commit_hash: Option<String>,
    device_id: String,
}

impl PulledWireRow {
    fn into_remote(self) -> RemoteRow {
        RemoteRow {
            row: SyncRow {
                uuid: self.uuid,
                ts: self.ts as i64,
                project: self.project,
                task: self.task,
                file: self.file,
                is_write: self.is_write,
                commit_hash: self.commit_hash,
            },
            device_id: self.device_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use serde_json::json;

    const DEVICE: &str = "device-local";

    struct Harness {
        home: tempfile::TempDir,
        conn: Connection,
        settings: Settings,
    }

    /// A home dir + migrated DB + settings pointing every endpoint at the
    /// mock server, logged in with a far-future token so no refresh fires
    /// unless a test asks for one.
    fn harness(server: &MockServer) -> Harness {
        let home = tempfile::tempdir().unwrap();
        let conn = db::open_db(&home.path().join("ledger.db"), DEVICE).unwrap();
        let settings = Settings {
            device_id: DEVICE.into(),
            device_name: "laptop".into(),
            convex_url: Some(server.base_url()),
            workos_client_id: Some("client_123".into()),
            workos_api_url: Some(server.base_url()),
        };
        log_in(&home, "at-fresh");
        Harness { home, conn, settings }
    }

    fn log_in(home: &tempfile::TempDir, access_token: &str) {
        settings::save_credentials(
            home.path(),
            &settings::Credentials {
                access_token: access_token.into(),
                refresh_token: "rt-1".into(),
                expires_at: Some(chrono::Utc::now().timestamp_millis() + 3_600_000),
            },
        )
        .unwrap();
    }

    fn insert_dirty(conn: &Connection, count: usize) {
        for i in 0..count {
            db::insert_heartbeat(
                conn,
                1_000 + i as i64,
                "foo",
                "main",
                None,
                false,
                &format!("uuid-{i}"),
                DEVICE,
            )
            .unwrap();
        }
    }

    fn success(value: Value) -> Value {
        json!({ "status": "success", "value": value })
    }

    fn empty_pull_mock(server: &MockServer) -> httpmock::Mock<'_> {
        server.mock(|when, then| {
            when.method(POST).path("/api/query");
            then.status(200).json_body(success(
                json!({ "rows": [], "nextCursor": 0, "isDone": true }),
            ));
        })
    }

    #[test]
    fn logged_out_is_a_silent_none_with_no_network_calls() {
        let server = MockServer::start();
        let mut h = harness(&server);
        settings::delete_credentials(h.home.path()).unwrap();
        let any_call = server.mock(|when, then| {
            when.any_request();
            then.status(500);
        });

        let outcome = sync_all(
            &mut h.conn,
            h.home.path(),
            &h.settings,
            Timeouts::interactive(),
            false,
        )
        .unwrap();

        assert_eq!(outcome, None);
        any_call.assert_hits(0);
    }

    #[test]
    fn push_sends_dirty_rows_in_batches_and_marks_them_clean() {
        let server = MockServer::start();
        let mut h = harness(&server);
        insert_dirty(&h.conn, BATCH_SIZE + 1); // forces two batches

        let push = server.mock(|when, then| {
            when.method(POST).path("/api/mutation");
            then.status(200)
                .json_body(success(json!({ "upserted": 1, "syncedAt": 42 })));
        });
        empty_pull_mock(&server);

        let outcome = sync_all(
            &mut h.conn,
            h.home.path(),
            &h.settings,
            Timeouts::interactive(),
            false,
        )
        .unwrap()
        .unwrap();

        push.assert_hits(2);
        assert_eq!(outcome.pushed, BATCH_SIZE + 1);
        assert!(db::select_dirty_batch(&h.conn, DEVICE, 10).unwrap().is_empty());
    }

    #[test]
    fn push_omits_absent_optional_fields_from_the_wire() {
        let server = MockServer::start();
        let mut h = harness(&server);
        insert_dirty(&h.conn, 1);

        // Exact body match: no "file"/"commitHash" keys may appear.
        let push = server.mock(|when, then| {
            when.method(POST)
                .path("/api/mutation")
                .header("authorization", "Bearer at-fresh")
                .json_body(json!({
                    "path": "sync:push",
                    "args": {
                        "deviceId": DEVICE,
                        "deviceName": "laptop",
                        "rows": [{
                            "uuid": "uuid-0",
                            "ts": 1_000,
                            "project": "foo",
                            "task": "main",
                            "isWrite": false,
                        }],
                    },
                    "format": "json",
                }));
            then.status(200)
                .json_body(success(json!({ "upserted": 1, "syncedAt": 42 })));
        });

        sync_all(
            &mut h.conn,
            h.home.path(),
            &h.settings,
            Timeouts::interactive(),
            true,
        )
        .unwrap()
        .unwrap();
        push.assert();
    }

    #[test]
    fn a_401_refreshes_once_persists_and_retries() {
        let server = MockServer::start();
        let mut h = harness(&server);
        log_in(&h.home, "at-stale");
        insert_dirty(&h.conn, 1);

        let rejected = server.mock(|when, then| {
            when.method(POST)
                .path("/api/mutation")
                .header("authorization", "Bearer at-stale");
            then.status(401).body("Unauthorized");
        });
        let refresh = server.mock(|when, then| {
            when.method(POST)
                .path("/user_management/authenticate")
                .x_www_form_urlencoded_tuple("grant_type", "refresh_token")
                .x_www_form_urlencoded_tuple("refresh_token", "rt-1");
            then.status(200).json_body(json!({
                "access_token": "at-new",
                "refresh_token": "rt-2",
            }));
        });
        let accepted = server.mock(|when, then| {
            when.method(POST)
                .path("/api/mutation")
                .header("authorization", "Bearer at-new");
            then.status(200)
                .json_body(success(json!({ "upserted": 1, "syncedAt": 42 })));
        });

        let outcome = sync_all(
            &mut h.conn,
            h.home.path(),
            &h.settings,
            Timeouts::interactive(),
            true,
        )
        .unwrap()
        .unwrap();

        rejected.assert();
        refresh.assert();
        accepted.assert();
        assert_eq!(outcome.pushed, 1);
        // The rotated pair must have been persisted, not just used in-memory.
        let persisted = settings::load_credentials(h.home.path()).unwrap().unwrap();
        assert_eq!(persisted.refresh_token, "rt-2");
    }

    #[test]
    fn a_dead_refresh_token_surfaces_the_login_hint() {
        let server = MockServer::start();
        let mut h = harness(&server);
        log_in(&h.home, "at-stale");
        insert_dirty(&h.conn, 1);

        server.mock(|when, then| {
            when.method(POST).path("/api/mutation");
            then.status(401).body("Unauthorized");
        });
        server.mock(|when, then| {
            when.method(POST).path("/user_management/authenticate");
            then.status(400).json_body(json!({ "error": "invalid_grant" }));
        });

        let err = sync_all(
            &mut h.conn,
            h.home.path(),
            &h.settings,
            Timeouts::interactive(),
            true,
        )
        .unwrap_err();
        // `{:#}` renders the whole context chain; the hint sits below the
        // outer "pushing heartbeats" context.
        let rendered = format!("{err:#}");
        assert!(rendered.contains("ledger login"), "got: {rendered}");
    }

    #[test]
    fn pull_walks_pages_by_cursor_and_applies_rows() {
        let server = MockServer::start();
        let mut h = harness(&server);

        let remote = |uuid: &str, ts: i64| {
            json!({
                "uuid": uuid, "ts": ts, "project": "foo", "task": "main",
                "isWrite": false, "deviceId": "device-other",
            })
        };
        let page1 = server.mock(|when, then| {
            when.method(POST)
                .path("/api/query")
                .json_body_partial(r#"{"args": {"cursor": 0}}"#);
            then.status(200).json_body(success(json!({
                "rows": [remote("r1", 1_000), remote("r2", 2_000)],
                "nextCursor": 10_000,
                "isDone": false,
            })));
        });
        let page2 = server.mock(|when, then| {
            when.method(POST)
                .path("/api/query")
                .json_body_partial(r#"{"args": {"cursor": 10000}}"#);
            then.status(200).json_body(success(json!({
                "rows": [remote("r3", 3_000)],
                "nextCursor": 20_000,
                "isDone": true,
            })));
        });

        let outcome = sync_all(
            &mut h.conn,
            h.home.path(),
            &h.settings,
            Timeouts::interactive(),
            false,
        )
        .unwrap()
        .unwrap();

        page1.assert();
        page2.assert();
        assert_eq!(outcome.pulled, 3);
        assert_eq!(db::get_pull_cursor(&h.conn).unwrap(), 20_000);
        // Pulled rows show up for `ledger report`'s query path.
        let hbs = db::query_heartbeats(&h.conn, None, None, None, None).unwrap();
        assert_eq!(hbs.len(), 3);
        // ...but never in this device's push batch.
        assert!(db::select_dirty_batch(&h.conn, DEVICE, 10).unwrap().is_empty());
    }

    #[test]
    fn a_mid_pull_failure_keeps_the_cursor_at_the_last_committed_page() {
        let server = MockServer::start();
        let mut h = harness(&server);

        server.mock(|when, then| {
            when.method(POST)
                .path("/api/query")
                .json_body_partial(r#"{"args": {"cursor": 0}}"#);
            then.status(200).json_body(success(json!({
                "rows": [{
                    "uuid": "r1", "ts": 1_000, "project": "foo", "task": "main",
                    "isWrite": false, "deviceId": "device-other",
                }],
                "nextCursor": 10_000,
                "isDone": false,
            })));
        });
        server.mock(|when, then| {
            when.method(POST)
                .path("/api/query")
                .json_body_partial(r#"{"args": {"cursor": 10000}}"#);
            then.status(560).body("boom");
        });

        let err = sync_all(
            &mut h.conn,
            h.home.path(),
            &h.settings,
            Timeouts::interactive(),
            false,
        )
        .unwrap_err();

        assert!(err.to_string().contains("pulling heartbeats"), "got: {err:#}");
        // Page 1 landed with its cursor; the retry will resume from 10_000.
        assert_eq!(db::get_pull_cursor(&h.conn).unwrap(), 10_000);
        assert_eq!(db::query_heartbeats(&h.conn, None, None, None, None).unwrap().len(), 1);
    }

    #[test]
    fn a_stuck_cursor_errors_instead_of_spinning() {
        let server = MockServer::start();
        let mut h = harness(&server);

        server.mock(|when, then| {
            when.method(POST).path("/api/query");
            then.status(200).json_body(success(json!({
                "rows": [],
                "nextCursor": 0,
                "isDone": false, // claims more, but no progress
            })));
        });

        let err = sync_all(
            &mut h.conn,
            h.home.path(),
            &h.settings,
            Timeouts::interactive(),
            false,
        )
        .unwrap_err();
        assert!(err.to_string().contains("did not advance"), "got: {err:#}");
    }
}
