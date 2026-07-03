//! Black-box tests of cloud sync: the compiled binary against an httpmock
//! Convex/WorkOS stand-in (everything overridden through LEDGER_* env
//! vars), plus the hook-safety guarantee — a `git commit` with the sync
//! endpoint unreachable still exits 0, fast.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::Instant;

use httpmock::prelude::*;
use serde_json::json;

const BIN: &str = env!("CARGO_BIN_EXE_ledger");

struct TestEnv {
    _tmp: tempfile::TempDir,
    repo: PathBuf,
    home: PathBuf,
}

fn setup() -> TestEnv {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let home = tmp.path().join("ledger-home");
    fs::create_dir_all(&repo).unwrap();
    let env = TestEnv {
        _tmp: tmp,
        repo,
        home,
    };
    git(&env, &["init", "--initial-branch=main"]);
    env
}

/// Hermetic env for every spawned process (same recipe as the init/hook
/// integration test) plus the LEDGER_* cloud overrides pointed at
/// `convex_url` / `workos_url`.
fn command(env: &TestEnv, program: &str, args: &[&str], convex_url: &str, workos_url: &str) -> Command {
    let bin_dir = Path::new(BIN).parent().unwrap();
    let path_var = format!(
        "{}:{}",
        bin_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(&env.repo)
        .env("LEDGER_HOME", &env.home)
        .env("LEDGER_CONVEX_URL", convex_url)
        .env("LEDGER_WORKOS_CLIENT_ID", "client_test")
        .env("LEDGER_WORKOS_API_URL", workos_url)
        .env("PATH", path_var)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com");
    cmd
}

fn git(env: &TestEnv, args: &[&str]) -> String {
    // git never talks to ledger endpoints itself, but the hook it spawns
    // inherits this environment — that's the point.
    let output = command(env, "git", args, "http://127.0.0.1:1", "http://127.0.0.1:1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "`git {}` failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim_end().to_string()
}

fn git_with_endpoints(env: &TestEnv, args: &[&str], convex_url: &str, workos_url: &str) -> Output {
    command(env, "git", args, convex_url, workos_url).output().unwrap()
}

fn ledger(env: &TestEnv, args: &[&str], convex_url: &str, workos_url: &str) -> Output {
    command(env, BIN, args, convex_url, workos_url).output().unwrap()
}

/// Drop a logged-in credentials.json into the temp home, far-future expiry
/// so no refresh traffic happens unless a test wants it.
fn log_in(home: &Path) {
    fs::create_dir_all(home).unwrap();
    let far_future = chrono::Utc::now().timestamp_millis() + 3_600_000;
    fs::write(
        home.join("credentials.json"),
        format!(
            r#"{{"accessToken": "at-test", "refreshToken": "rt-test", "expiresAt": {far_future}}}"#
        ),
    )
    .unwrap();
}

#[test]
fn sync_pushes_local_heartbeats_and_pulls_foreign_ones() {
    let env = setup();
    let server = MockServer::start();
    let convex = server.base_url();
    let workos = server.base_url();

    // One local heartbeat lands dirty in the temp DB.
    let out = ledger(&env, &["heartbeat", "--file", "src/main.rs"], &convex, &workos);
    assert!(out.status.success());
    log_in(&env.home);

    let push = server.mock(|when, then| {
        when.method(POST)
            .path("/api/mutation")
            .header("authorization", "Bearer at-test");
        then.status(200).json_body(json!({
            "status": "success",
            "value": { "upserted": 1, "syncedAt": 10_000 },
        }));
    });
    let pull = server.mock(|when, then| {
        when.method(POST)
            .path("/api/query")
            .header("authorization", "Bearer at-test");
        then.status(200).json_body(json!({
            "status": "success",
            "value": {
                "rows": [{
                    "uuid": "uuid-remote",
                    "ts": 2_000,
                    "project": "repo",
                    "task": "main",
                    "isWrite": false,
                    "commitHash": "beef123",
                    "deviceId": "device-other",
                }],
                "nextCursor": 10_000,
                "isDone": true,
            },
        }));
    });

    let out = ledger(&env, &["sync"], &convex, &workos);
    assert!(
        out.status.success(),
        "sync failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("pushed 1 heartbeat(s), pulled 1"), "got: {stdout}");

    push.assert();
    pull.assert();

    // The foreign row landed clean; the local row is clean after its push;
    // the cursor is at the server's syncedAt.
    let conn = rusqlite::Connection::open(env.home.join("ledger.db")).unwrap();
    let (count, dirty): (i64, i64) = conn
        .query_row(
            "SELECT count(*), coalesce(sum(dirty), 0) FROM heartbeats",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(count, 2);
    assert_eq!(dirty, 0);
    let cursor: String = conn
        .query_row("SELECT value FROM sync_state WHERE key = 'pull_cursor'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cursor, "10000");

    // The pulled heartbeat is real data: report aggregates it.
    let out = ledger(&env, &["report"], &convex, &workos);
    assert!(out.status.success());
    let report = String::from_utf8_lossy(&out.stdout);
    assert!(report.contains("repo"), "report should show the project, got: {report}");
}

#[test]
fn sync_without_login_fails_with_a_friendly_hint() {
    let env = setup();
    let out = ledger(&env, &["sync"], "http://127.0.0.1:1", "http://127.0.0.1:1");
    assert!(!out.status.success(), "sync while logged out should fail loudly");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("ledger login"), "got: {stderr}");
}

#[test]
fn a_commit_with_the_endpoint_unreachable_still_exits_zero_and_fast() {
    let env = setup();
    // 127.0.0.1:1 refuses connections immediately — an unreachable backend
    // without a multi-second timeout wait.
    let dead = "http://127.0.0.1:1";

    let out = ledger(&env, &["init"], dead, dead);
    assert!(out.status.success());
    let out = ledger(&env, &["heartbeat"], dead, dead);
    assert!(out.status.success());
    log_in(&env.home); // logged in, so the hook really attempts the push

    fs::write(env.repo.join("file.txt"), "hello").unwrap();
    git(&env, &["add", "."]);

    let started = Instant::now();
    let out = git_with_endpoints(&env, &["commit", "-m", "offline commit"], dead, dead);
    let elapsed = started.elapsed();

    assert!(
        out.status.success(),
        "commit must survive a dead sync endpoint: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        elapsed.as_secs() < 5,
        "commit took {elapsed:?} — the hook must not block on the network"
    );

    // Tagging still happened even though the push failed...
    let head = git(&env, &["rev-parse", "HEAD"]);
    let conn = rusqlite::Connection::open(env.home.join("ledger.db")).unwrap();
    let tagged: i64 = conn
        .query_row(
            "SELECT count(*) FROM heartbeats WHERE commit_hash = ?1",
            [head.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tagged, 1, "hook must tag before attempting the push");

    // ...the row stays dirty for the next sync, and the failure is logged.
    let dirty: i64 = conn
        .query_row("SELECT count(*) FROM heartbeats WHERE dirty = 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(dirty, 1);
    let log = fs::read_to_string(env.home.join("error.log")).unwrap();
    assert!(log.contains("sync push failed"), "got: {log}");
}
