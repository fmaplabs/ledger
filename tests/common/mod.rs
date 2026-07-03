//! Shared harness for black-box integration tests: a real temp repo and a
//! temp LEDGER_HOME, with every spawned process (git or ledger) getting
//! the same hermetic environment.

#![allow(dead_code)] // each test binary uses a different subset

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// Cargo sets CARGO_BIN_EXE_<name> for integration tests — the path to the
/// compiled binary under test.
pub const BIN: &str = env!("CARGO_BIN_EXE_ledger");

pub struct TestEnv {
    _tmp: tempfile::TempDir, // held for its Drop; deletes everything below
    pub repo: PathBuf,
    pub home: PathBuf,
}

pub fn setup() -> TestEnv {
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

/// Every process in the test — git or ledger (whose hook runs git, and
/// which itself shells out to git) — gets the same hermetic environment:
/// the temp LEDGER_HOME, no user/system git config, a pinned identity,
/// and the compiled binary's directory on PATH so the hook can find it.
pub fn command(env: &TestEnv, program: &str, args: &[&str]) -> Command {
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
        .env("PATH", path_var)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com");
    cmd
}

pub fn git(env: &TestEnv, args: &[&str]) -> String {
    let output = command(env, "git", args).output().unwrap();
    assert!(
        output.status.success(),
        "`git {}` failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim_end().to_string()
}

pub fn ledger(env: &TestEnv, args: &[&str]) -> Output {
    command(env, BIN, args).output().unwrap()
}
