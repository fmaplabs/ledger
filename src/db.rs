use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, params};

use crate::sessions::Heartbeat;

const SCHEMA_V1: &str = "
CREATE TABLE IF NOT EXISTS heartbeats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    project     TEXT NOT NULL,
    task        TEXT NOT NULL,
    file        TEXT,
    is_write    INTEGER NOT NULL DEFAULT 0,
    commit_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_project_task_ts
    ON heartbeats (project, task, ts);
CREATE INDEX IF NOT EXISTS idx_heartbeats_commit_hash
    ON heartbeats (commit_hash);
";

/// Open (creating if necessary) the heartbeat database and run any pending
/// migrations. WAL + a busy timeout let an editor heartbeat and a
/// post-commit hook write concurrently without either erroring out.
///
/// `device_id` is this machine's stable id (from `settings::load_or_init`):
/// the v2 migration stamps it onto pre-existing rows, which were all
/// necessarily created here.
pub fn open_db(path: &Path, device_id: &str) -> rusqlite::Result<Connection> {
    let mut conn = Connection::open(path)?;
    // `PRAGMA journal_mode=WAL` returns the resulting mode as a row, so it
    // has to be run as a query — `execute` would reject the returned row.
    let _mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    migrate(&mut conn, device_id)?;
    Ok(conn)
}

/// Versioned migrations keyed off `PRAGMA user_version`. Pre-migration DBs
/// report version 0 whether they're brand new or already carry the v1 table
/// (the v1 DDL never set the version) — re-applying the `IF NOT EXISTS` v1
/// DDL is harmless in both cases.
fn migrate(conn: &mut Connection, device_id: &str) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version < 1 {
        conn.execute_batch(SCHEMA_V1)?;
        conn.pragma_update(None, "user_version", 1)?;
    }
    if version < 2 {
        migrate_v1_to_v2(conn, device_id)?;
    }
    Ok(())
}

/// v2 adds cloud sync: a globally unique per-row `uuid`, the owning
/// `device_id`, a `dirty` push flag, and the `sync_state` cursor table.
/// Everything (including the version bump) happens in one transaction so a
/// crash mid-migration leaves a clean v1 database.
fn migrate_v1_to_v2(conn: &mut Connection, device_id: &str) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "ALTER TABLE heartbeats ADD COLUMN uuid TEXT;
         ALTER TABLE heartbeats ADD COLUMN device_id TEXT;
         ALTER TABLE heartbeats ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1;",
    )?;
    // Every pre-v2 row was created on this machine and has never been
    // pushed: claim it and mark it for the first sync.
    tx.execute(
        "UPDATE heartbeats SET device_id = ?1, dirty = 1",
        params![device_id],
    )?;
    {
        let ids: Vec<i64> = tx
            .prepare("SELECT id FROM heartbeats WHERE uuid IS NULL")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut stmt = tx.prepare("UPDATE heartbeats SET uuid = ?1 WHERE id = ?2")?;
        for id in ids {
            stmt.execute(params![uuid::Uuid::new_v4().to_string(), id])?;
        }
    }
    tx.execute_batch(
        "CREATE UNIQUE INDEX idx_heartbeats_uuid ON heartbeats (uuid);
         CREATE INDEX idx_heartbeats_dirty ON heartbeats (dirty) WHERE dirty = 1;
         CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )?;
    tx.pragma_update(None, "user_version", 2)?;
    tx.commit()
}

#[allow(clippy::too_many_arguments)]
pub fn insert_heartbeat(
    conn: &Connection,
    ts: i64,
    project: &str,
    task: &str,
    file: Option<&str>,
    is_write: bool,
    uuid: &str,
    device_id: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO heartbeats (ts, project, task, file, is_write, uuid, device_id, dirty)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
        params![ts, project, task, file, is_write, uuid, device_id],
    )?;
    Ok(())
}

/// Fetch heartbeats matching the given filters (each `None` means "don't
/// filter"), ordered by `ts ASC` — the order `collapse_into_sessions` expects.
/// `since` is inclusive, `until` exclusive.
pub fn query_heartbeats(
    conn: &Connection,
    project: Option<&str>,
    task: Option<&str>,
    since: Option<i64>,
    until: Option<i64>,
) -> rusqlite::Result<Vec<Heartbeat>> {
    let mut stmt = conn.prepare(
        "SELECT ts, project, task, commit_hash FROM heartbeats
         WHERE (?1 IS NULL OR project = ?1)
           AND (?2 IS NULL OR task = ?2)
           AND (?3 IS NULL OR ts >= ?3)
           AND (?4 IS NULL OR ts < ?4)
         ORDER BY ts ASC",
    )?;
    let rows = stmt.query_map(params![project, task, since, until], |row| {
        Ok(Heartbeat {
            ts: row.get(0)?,
            project: row.get(1)?,
            task: row.get(2)?,
            commit_hash: row.get(3)?,
        })
    })?;
    rows.collect()
}

/// Stamp `commit_hash` onto every not-yet-tagged heartbeat for this
/// project/task — called by the post-commit hook. Returns how many rows were
/// tagged.
///
/// Scoped to this machine's `device_id`: rows pulled from other machines are
/// read-only copies, and claiming their untagged heartbeats here would make
/// two devices disagree about the same row forever.
pub fn tag_untagged_heartbeats(
    conn: &Connection,
    project: &str,
    task: &str,
    commit_hash: &str,
    device_id: &str,
) -> rusqlite::Result<usize> {
    // Tagging mutates a row after it may already have been pushed, so it
    // re-dirties the row to get the commit hash synced too.
    conn.execute(
        "UPDATE heartbeats SET commit_hash = ?3, dirty = 1
         WHERE project = ?1 AND task = ?2 AND commit_hash IS NULL AND device_id = ?4",
        params![project, task, commit_hash, device_id],
    )
}

/// One heartbeat as it travels over the sync wire (no local `id`, no `dirty`).
#[derive(Debug, Clone, PartialEq)]
pub struct SyncRow {
    pub uuid: String,
    pub ts: i64,
    pub project: String,
    pub task: String,
    pub file: Option<String>,
    pub is_write: bool,
    pub commit_hash: Option<String>,
}

/// A row pulled from the server: some other device's `SyncRow`.
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteRow {
    pub row: SyncRow,
    pub device_id: String,
}

/// The next batch of this device's rows awaiting push, oldest first.
pub fn select_dirty_batch(
    conn: &Connection,
    device_id: &str,
    limit: usize,
) -> rusqlite::Result<Vec<SyncRow>> {
    let mut stmt = conn.prepare(
        "SELECT uuid, ts, project, task, file, is_write, commit_hash FROM heartbeats
         WHERE dirty = 1 AND device_id = ?1
         ORDER BY id
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![device_id, limit as i64], |row| {
        Ok(SyncRow {
            uuid: row.get(0)?,
            ts: row.get(1)?,
            project: row.get(2)?,
            task: row.get(3)?,
            file: row.get(4)?,
            is_write: row.get(5)?,
            commit_hash: row.get(6)?,
        })
    })?;
    rows.collect()
}

/// Clear the dirty flag on rows that were just pushed — but only if the row
/// still looks exactly like what was sent. `commit_hash` is the one field
/// mutated after insert (by the post-commit hook), so `commit_hash IS ?`
/// detects a row re-tagged mid-push and leaves it dirty for the next sync.
pub fn mark_clean(conn: &mut Connection, pushed: &[SyncRow]) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    let mut cleaned = 0;
    {
        let mut stmt =
            tx.prepare("UPDATE heartbeats SET dirty = 0 WHERE uuid = ?1 AND commit_hash IS ?2")?;
        for row in pushed {
            cleaned += stmt.execute(params![row.uuid, row.commit_hash])?;
        }
    }
    tx.commit()?;
    Ok(cleaned)
}

/// Upsert one page of pulled rows and advance the pull cursor, atomically:
/// the cursor must never point past rows that didn't land.
///
/// `ON CONFLICT(uuid) DO UPDATE` (rather than `INSERT OR REPLACE`) keeps the
/// existing local `id` stable — REPLACE would delete + reinsert, churning
/// autoincrement ids for no reason. Pulled rows land with `dirty = 0`: they
/// belong to another device and must never be pushed back.
pub fn apply_pulled_rows(
    conn: &mut Connection,
    rows: &[RemoteRow],
    new_cursor: i64,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO heartbeats (ts, project, task, file, is_write, commit_hash, uuid, device_id, dirty)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)
             ON CONFLICT(uuid) DO UPDATE SET
                 ts = excluded.ts, project = excluded.project, task = excluded.task,
                 file = excluded.file, is_write = excluded.is_write,
                 commit_hash = excluded.commit_hash, device_id = excluded.device_id,
                 dirty = 0",
        )?;
        for remote in rows {
            let r = &remote.row;
            stmt.execute(params![
                r.ts,
                r.project,
                r.task,
                r.file,
                r.is_write,
                r.commit_hash,
                r.uuid,
                remote.device_id,
            ])?;
        }
    }
    tx.execute(
        "INSERT INTO sync_state (key, value) VALUES ('pull_cursor', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![new_cursor.to_string()],
    )?;
    tx.commit()
}

/// Where the last completed pull left off (a server-side `syncedAt` value);
/// 0 means "never pulled".
pub fn get_pull_cursor(conn: &Connection) -> rusqlite::Result<i64> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM sync_state WHERE key = 'pull_cursor'",
            [],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    // An unparseable cursor degrades to a full re-pull, which the idempotent
    // upsert absorbs — safer than refusing to sync at all.
    Ok(value.and_then(|v| v.parse().ok()).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MY_DEVICE: &str = "device-local";

    fn test_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn, MY_DEVICE).unwrap();
        conn
    }

    fn insert(conn: &Connection, ts: i64, project: &str, task: &str) -> String {
        let uuid = uuid::Uuid::new_v4().to_string();
        insert_heartbeat(conn, ts, project, task, None, false, &uuid, MY_DEVICE).unwrap();
        uuid
    }

    fn remote_row(uuid: &str, ts: i64, device_id: &str) -> RemoteRow {
        RemoteRow {
            row: SyncRow {
                uuid: uuid.to_string(),
                ts,
                project: "foo".into(),
                task: "main".into(),
                file: None,
                is_write: false,
                commit_hash: None,
            },
            device_id: device_id.to_string(),
        }
    }

    #[test]
    fn insert_then_query_round_trips() {
        let conn = test_db();
        insert_heartbeat(
            &conn,
            1_000,
            "foo",
            "main",
            Some("src/lib.rs"),
            true,
            "uuid-1",
            MY_DEVICE,
        )
        .unwrap();

        let hbs = query_heartbeats(&conn, None, None, None, None).unwrap();
        assert_eq!(hbs.len(), 1);
        assert_eq!(hbs[0].ts, 1_000);
        assert_eq!(hbs[0].project, "foo");
        assert_eq!(hbs[0].task, "main");
        assert_eq!(hbs[0].commit_hash, None);
    }

    #[test]
    fn query_orders_by_ts_ascending() {
        let conn = test_db();
        for ts in [3_000, 1_000, 2_000] {
            insert(&conn, ts, "foo", "main");
        }

        let hbs = query_heartbeats(&conn, None, None, None, None).unwrap();
        let timestamps: Vec<i64> = hbs.iter().map(|hb| hb.ts).collect();
        assert_eq!(timestamps, vec![1_000, 2_000, 3_000]);
    }

    #[test]
    fn query_filters_by_project_task_and_time_window() {
        let conn = test_db();
        insert(&conn, 1_000, "foo", "main");
        insert(&conn, 2_000, "foo", "feature");
        insert(&conn, 3_000, "bar", "main");

        let foo = query_heartbeats(&conn, Some("foo"), None, None, None).unwrap();
        assert_eq!(foo.len(), 2);

        let foo_main = query_heartbeats(&conn, Some("foo"), Some("main"), None, None).unwrap();
        assert_eq!(foo_main.len(), 1);
        assert_eq!(foo_main[0].ts, 1_000);

        // since inclusive, until exclusive
        let windowed = query_heartbeats(&conn, None, None, Some(2_000), Some(3_000)).unwrap();
        assert_eq!(windowed.len(), 1);
        assert_eq!(windowed[0].ts, 2_000);
    }

    #[test]
    fn tagging_only_touches_untagged_rows_for_that_project_and_task() {
        let conn = test_db();
        insert(&conn, 1_000, "foo", "main");
        insert(&conn, 2_000, "foo", "main");
        insert(&conn, 3_000, "foo", "feature");
        insert(&conn, 4_000, "bar", "main");

        let tagged = tag_untagged_heartbeats(&conn, "foo", "main", "abc123", MY_DEVICE).unwrap();
        assert_eq!(tagged, 2);

        // A second commit must not re-tag rows the first one claimed.
        insert(&conn, 5_000, "foo", "main");
        let tagged = tag_untagged_heartbeats(&conn, "foo", "main", "def456", MY_DEVICE).unwrap();
        assert_eq!(tagged, 1);

        let hbs = query_heartbeats(&conn, None, None, None, None).unwrap();
        let hashes: Vec<Option<&str>> = hbs.iter().map(|hb| hb.commit_hash.as_deref()).collect();
        assert_eq!(
            hashes,
            vec![
                Some("abc123"),
                Some("abc123"),
                None, // foo/feature untouched
                None, // bar/main untouched
                Some("def456"),
            ]
        );
    }

    // The sync regression this stage exists to prevent: a pulled copy of
    // another machine's untagged heartbeat must never be claimed by a local
    // commit — only its owning device may set its commit hash.
    #[test]
    fn tagging_never_touches_pulled_foreign_device_rows() {
        let mut conn = test_db();
        insert(&conn, 1_000, "foo", "main");
        apply_pulled_rows(&mut conn, &[remote_row("uuid-remote", 2_000, "device-other")], 10)
            .unwrap();

        let tagged = tag_untagged_heartbeats(&conn, "foo", "main", "abc123", MY_DEVICE).unwrap();
        assert_eq!(tagged, 1, "only the local row may be tagged");

        let (remote_hash, remote_dirty): (Option<String>, i64) = conn
            .query_row(
                "SELECT commit_hash, dirty FROM heartbeats WHERE uuid = 'uuid-remote'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(remote_hash, None);
        assert_eq!(remote_dirty, 0, "foreign rows must stay clean");
    }

    #[test]
    fn migrating_a_v1_database_claims_and_dirties_every_existing_row() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("ledger.db");

        // Build a pre-stage-12 database: v1 table, rows, user_version 0.
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        for ts in [1_000, 2_000, 3_000] {
            conn.execute(
                "INSERT INTO heartbeats (ts, project, task) VALUES (?1, 'foo', 'main')",
                params![ts],
            )
            .unwrap();
        }
        drop(conn);

        let conn = open_db(&path, MY_DEVICE).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);

        let mut stmt = conn
            .prepare("SELECT uuid, device_id, dirty FROM heartbeats")
            .unwrap();
        let rows: Vec<(String, String, i64)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(rows.len(), 3);
        let mut uuids: Vec<&str> = rows.iter().map(|(u, _, _)| u.as_str()).collect();
        for (uuid, device, dirty) in &rows {
            uuid::Uuid::parse_str(uuid).expect("backfilled uuid is a real uuid");
            assert_eq!(device, MY_DEVICE);
            assert_eq!(*dirty, 1);
        }
        uuids.sort();
        uuids.dedup();
        assert_eq!(uuids.len(), 3, "uuids must be unique");
        drop(stmt);
        drop(conn);

        // Re-opening (even with a different device id) must not re-migrate.
        let conn = open_db(&path, "some-other-device").unwrap();
        let foreign: i64 = conn
            .query_row(
                "SELECT count(*) FROM heartbeats WHERE device_id != ?1",
                params![MY_DEVICE],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(foreign, 0, "migration must not run twice");
    }

    #[test]
    fn dirty_lifecycle_insert_select_clean() {
        let mut conn = test_db();
        insert(&conn, 1_000, "foo", "main");
        insert(&conn, 2_000, "foo", "main");

        let batch = select_dirty_batch(&conn, MY_DEVICE, 500).unwrap();
        assert_eq!(batch.len(), 2);
        assert_eq!(batch[0].ts, 1_000, "oldest first");

        // Foreign rows never appear in the push batch, dirty or not.
        assert!(select_dirty_batch(&conn, "device-other", 500).unwrap().is_empty());

        let cleaned = mark_clean(&mut conn, &batch).unwrap();
        assert_eq!(cleaned, 2);
        assert!(select_dirty_batch(&conn, MY_DEVICE, 500).unwrap().is_empty());

        // Tagging re-dirties: the updated commit hash must sync too.
        tag_untagged_heartbeats(&conn, "foo", "main", "abc123", MY_DEVICE).unwrap();
        assert_eq!(select_dirty_batch(&conn, MY_DEVICE, 500).unwrap().len(), 2);
    }

    #[test]
    fn select_dirty_batch_respects_the_limit() {
        let conn = test_db();
        for ts in 0..5 {
            insert(&conn, ts, "foo", "main");
        }
        assert_eq!(select_dirty_batch(&conn, MY_DEVICE, 3).unwrap().len(), 3);
    }

    #[test]
    fn mark_clean_skips_rows_retagged_mid_push() {
        let mut conn = test_db();
        insert(&conn, 1_000, "foo", "main");

        let batch = select_dirty_batch(&conn, MY_DEVICE, 500).unwrap();
        // Simulate the post-commit hook firing between select and the push
        // response landing: commit_hash changes under the in-flight batch.
        tag_untagged_heartbeats(&conn, "foo", "main", "abc123", MY_DEVICE).unwrap();

        let cleaned = mark_clean(&mut conn, &batch).unwrap();
        assert_eq!(cleaned, 0, "changed row must stay dirty");
        assert_eq!(select_dirty_batch(&conn, MY_DEVICE, 500).unwrap().len(), 1);
    }

    #[test]
    fn apply_pulled_rows_upserts_in_place_and_stays_clean() {
        let mut conn = test_db();
        apply_pulled_rows(&mut conn, &[remote_row("uuid-r", 1_000, "device-other")], 5).unwrap();

        let id_before: i64 = conn
            .query_row("SELECT id FROM heartbeats WHERE uuid = 'uuid-r'", [], |r| r.get(0))
            .unwrap();

        // The same row arrives again, now tagged by its owner.
        let mut updated = remote_row("uuid-r", 1_000, "device-other");
        updated.row.commit_hash = Some("abc123".into());
        apply_pulled_rows(&mut conn, &[updated], 9).unwrap();

        let (id_after, hash, dirty): (i64, Option<String>, i64) = conn
            .query_row(
                "SELECT id, commit_hash, dirty FROM heartbeats WHERE uuid = 'uuid-r'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(id_after, id_before, "upsert must not churn the local id");
        assert_eq!(hash.as_deref(), Some("abc123"));
        assert_eq!(dirty, 0);
        assert_eq!(get_pull_cursor(&conn).unwrap(), 9);
    }

    #[test]
    fn apply_pulled_rows_is_atomic_rows_and_cursor_land_together() {
        let mut conn = test_db();
        // Force the cursor write (the last statement in the transaction) to
        // fail: the rows upserted before it must roll back with it.
        conn.execute_batch("DROP TABLE sync_state").unwrap();

        let result =
            apply_pulled_rows(&mut conn, &[remote_row("uuid-r", 1_000, "device-other")], 5);
        assert!(result.is_err());

        let count: i64 = conn
            .query_row("SELECT count(*) FROM heartbeats", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0, "rows must not land without the cursor");
    }

    #[test]
    fn pull_cursor_defaults_to_zero() {
        let conn = test_db();
        assert_eq!(get_pull_cursor(&conn).unwrap(), 0);
    }

    // WAL is a no-op for in-memory connections (they always report "memory"),
    // so asserting it there would be meaningless — verify against a real file.
    #[test]
    fn open_db_puts_a_file_backed_db_into_wal_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let conn = open_db(&tmp.path().join("ledger.db"), MY_DEVICE).unwrap();

        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
    }

    #[test]
    fn open_db_is_idempotent_and_keeps_existing_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("ledger.db");

        let conn = open_db(&path, MY_DEVICE).unwrap();
        insert(&conn, 1_000, "foo", "main");
        drop(conn);

        let conn = open_db(&path, MY_DEVICE).unwrap(); // re-running DDL must not clobber
        let hbs = query_heartbeats(&conn, None, None, None, None).unwrap();
        assert_eq!(hbs.len(), 1);
    }
}
