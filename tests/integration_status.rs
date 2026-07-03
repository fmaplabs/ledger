//! Black-box test of `ledger status --json`: real heartbeats recorded by
//! the compiled binary, timestamps spread via SQL, and the JSON contract the
//! editor plugin depends on asserted field by field.

mod common;

use std::fs;
use std::process::Command;

use common::{BIN, ledger, setup};

#[test]
fn status_reports_identity_and_todays_tracked_time() {
    let env = setup();

    for _ in 0..2 {
        let out = ledger(&env, &["heartbeat", "--file", "src/main.rs"]);
        assert!(out.status.success());
    }

    // Spread the two heartbeats 5 minutes apart (still inside the 15-minute
    // idle threshold) so today's tracked time is a deterministic 300000 ms.
    let conn = rusqlite::Connection::open(env.home.join("ledger.db")).unwrap();
    conn.execute(
        "UPDATE heartbeats
         SET ts = (SELECT MAX(ts) FROM heartbeats) - 300000
         WHERE id = (SELECT MIN(id) FROM heartbeats)",
        [],
    )
    .unwrap();
    let last_ts: i64 = conn
        .query_row("SELECT MAX(ts) FROM heartbeats", [], |row| row.get(0))
        .unwrap();
    drop(conn);

    let out = ledger(&env, &["status", "--json"]);
    assert!(
        out.status.success(),
        "status failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let status: serde_json::Value =
        serde_json::from_slice(&out.stdout).expect("status --json must print one JSON object");

    assert_eq!(status["project"], "repo");
    assert_eq!(status["task"], "main");
    assert_eq!(status["trackedTodayMs"], 300_000);
    assert_eq!(status["lastHeartbeatMs"], last_ts);
    assert_eq!(status["idleThresholdMinutes"], 15);
}

#[test]
fn status_outside_a_repo_exits_zero_with_nulls() {
    let tmp = tempfile::tempdir().unwrap();
    let not_a_repo = tmp.path().join("plain-dir");
    let home = tmp.path().join("ledger-home");
    fs::create_dir_all(&not_a_repo).unwrap();

    let out = Command::new(BIN)
        .args(["status", "--json"])
        .current_dir(&not_a_repo)
        .env("LEDGER_HOME", &home)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .output()
        .unwrap();

    // One code path for the consumer: exit 0 and the same shape, nulled out.
    assert!(out.status.success(), "status outside a repo must exit 0");
    let status: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(status["project"], serde_json::Value::Null);
    assert_eq!(status["task"], serde_json::Value::Null);
    assert_eq!(status["trackedTodayMs"], 0);
    assert_eq!(status["lastHeartbeatMs"], serde_json::Value::Null);
    assert_eq!(status["idleThresholdMinutes"], 15);
}
