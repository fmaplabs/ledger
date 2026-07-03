use std::any::Any;
use std::fs::OpenOptions;
use std::io::Write;
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;

use anyhow::Result;

use crate::paths;

/// Append one timestamped line to `~/.ledger/error.log`. Best-effort: if
/// the log itself can't be written there is nowhere left to report to, so
/// the failure is swallowed.
pub fn log_error(message: &str) {
    let Ok(home) = paths::ensure_ledger_home() else {
        return;
    };
    log_error_to(&paths::error_log_path(&home), message);
}

fn log_error_to(log_path: &Path, message: &str) {
    // One log entry per line: git stderr and friends can be multi-line.
    let message = message.replace('\n', " | ");
    let line = format!("[{}] {}\n", chrono::Utc::now().to_rfc3339(), message);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Run `f`, guaranteeing the failure of `f` never reaches the caller: errors
/// and panics are appended to the error log and swallowed. Returns normally
/// rather than calling `process::exit(0)` itself — that keeps it callable
/// from tests, and lets `main` exit 0 the ordinary way.
///
/// This is the wrapper that makes `heartbeat` and `hook-commit` incapable of
/// breaking an editor or blocking a `git commit`.
pub fn run_silently<F>(f: F)
where
    F: FnOnce() -> Result<()>,
{
    let log_path = paths::ensure_ledger_home()
        .ok()
        .map(|home| paths::error_log_path(&home));
    run_silently_at(log_path.as_deref(), f);
}

fn run_silently_at<F>(log_path: Option<&Path>, f: F)
where
    F: FnOnce() -> Result<()>,
{
    // The default panic hook prints to stderr *before* unwinding reaches
    // catch_unwind — silence it for the duration so a panic is only ever
    // visible in the error log.
    let prev_hook = panic::take_hook();
    panic::set_hook(Box::new(|_| {}));
    // `f` captures `&mut`/owned state we can't prove UnwindSafe; we never
    // touch that state again after a panic, so asserting is sound here.
    let outcome = panic::catch_unwind(AssertUnwindSafe(f));
    panic::set_hook(prev_hook);

    let message = match outcome {
        Ok(Ok(())) => return,
        // `{:#}` renders the whole anyhow context chain on one line.
        Ok(Err(e)) => format!("{e:#}"),
        Err(payload) => format!("panic: {}", panic_message(payload.as_ref())),
    };
    if let Some(path) = log_path {
        log_error_to(path, &message);
    }
}

/// Panic payloads are `Box<dyn Any>`; in practice they're almost always the
/// `&str`/`String` from a `panic!` call.
fn panic_message(payload: &(dyn Any + Send)) -> &str {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        s
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s
    } else {
        "<non-string panic payload>"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::{Context, anyhow};

    fn temp_log() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("error.log");
        (tmp, path)
    }

    #[test]
    fn ok_closure_writes_no_log() {
        let (_tmp, log) = temp_log();
        run_silently_at(Some(&log), || Ok(()));
        assert!(!log.exists());
    }

    #[test]
    fn err_closure_logs_the_full_context_chain() {
        let (_tmp, log) = temp_log();
        run_silently_at(Some(&log), || {
            Err(anyhow!("db locked")).context("inserting heartbeat")
        });

        let contents = std::fs::read_to_string(&log).unwrap();
        assert!(contents.contains("inserting heartbeat"));
        assert!(contents.contains("db locked"));
    }

    #[test]
    fn panicking_closure_is_caught_and_logged() {
        let (_tmp, log) = temp_log();
        run_silently_at(Some(&log), || panic!("kaboom: {}", 42));

        // Reaching this line at all proves catch_unwind caught it.
        let contents = std::fs::read_to_string(&log).unwrap();
        assert!(contents.contains("panic: kaboom: 42"));
    }

    #[test]
    fn log_lines_are_appended_not_truncated() {
        let (_tmp, log) = temp_log();
        run_silently_at(Some(&log), || Err(anyhow!("first")));
        run_silently_at(Some(&log), || Err(anyhow!("second")));

        let contents = std::fs::read_to_string(&log).unwrap();
        assert_eq!(contents.lines().count(), 2);
        assert!(contents.contains("first"));
        assert!(contents.contains("second"));
    }
}
