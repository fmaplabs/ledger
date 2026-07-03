use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};

/// Env var that overrides the default `~/.ledger` location. Set by the
/// integration tests (and usable by anyone who wants the data elsewhere).
pub const HOME_ENV_VAR: &str = "LEDGER_HOME";

const HOME_DIR_NAME: &str = ".ledger";
const DB_FILE_NAME: &str = "ledger.db";
const ERROR_LOG_FILE_NAME: &str = "error.log";

/// Resolve the ledger home directory without touching the filesystem:
/// `$LEDGER_HOME` if set (and non-empty), otherwise `~/.ledger`.
pub fn ledger_home() -> Result<PathBuf> {
    resolve_home(env::var_os(HOME_ENV_VAR), dirs::home_dir())
}

/// Resolve the ledger home directory and create it if it doesn't exist.
pub fn ensure_ledger_home() -> Result<PathBuf> {
    let home = ledger_home()?;
    fs::create_dir_all(&home)
        .with_context(|| format!("creating ledger home at {}", home.display()))?;
    Ok(home)
}

pub fn db_path(ledger_home: &Path) -> PathBuf {
    ledger_home.join(DB_FILE_NAME)
}

pub fn error_log_path(ledger_home: &Path) -> PathBuf {
    ledger_home.join(ERROR_LOG_FILE_NAME)
}

/// The pure core of `ledger_home`: both environment lookups are passed in
/// so this can be unit-tested without mutating process-global env vars.
fn resolve_home(override_dir: Option<OsString>, os_home_dir: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(dir) = override_dir.filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    let home = os_home_dir.ok_or_else(|| {
        anyhow!("could not resolve a home directory (and {HOME_ENV_VAR} is not set)")
    })?;
    Ok(home.join(HOME_DIR_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_dot_ledger_under_home() {
        let home = resolve_home(None, Some(PathBuf::from("/home/someone"))).unwrap();
        assert_eq!(home, PathBuf::from("/home/someone/.ledger"));
    }

    #[test]
    fn env_override_wins_over_os_home() {
        let home = resolve_home(
            Some(OsString::from("/custom/spot")),
            Some(PathBuf::from("/home/someone")),
        )
        .unwrap();
        assert_eq!(home, PathBuf::from("/custom/spot"));
    }

    #[test]
    fn empty_env_override_is_treated_as_unset() {
        let home = resolve_home(
            Some(OsString::new()),
            Some(PathBuf::from("/home/someone")),
        )
        .unwrap();
        assert_eq!(home, PathBuf::from("/home/someone/.ledger"));
    }

    #[test]
    fn no_home_and_no_override_is_an_error() {
        let err = resolve_home(None, None).unwrap_err();
        assert!(err.to_string().contains(HOME_ENV_VAR));
    }

    #[test]
    fn db_and_error_log_paths_live_inside_home() {
        let home = PathBuf::from("/x/.ledger");
        assert_eq!(db_path(&home), PathBuf::from("/x/.ledger/ledger.db"));
        assert_eq!(
            error_log_path(&home),
            PathBuf::from("/x/.ledger/error.log")
        );
    }

    #[test]
    fn create_dir_all_creates_missing_home_and_tolerates_existing() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("nested").join(".ledger");

        // Same call ensure_ledger_home makes, against a temp path.
        fs::create_dir_all(&home).unwrap();
        assert!(home.is_dir());
        fs::create_dir_all(&home).unwrap(); // already exists → still Ok
    }
}
