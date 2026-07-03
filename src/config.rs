use std::fs;
use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::errors;

pub const CONFIG_FILE_NAME: &str = ".ledger.json";
pub const DEFAULT_IDLE_THRESHOLD_MINUTES: u32 = 15;

/// Optional per-repo config, checked into the repo root as `.ledger.json`.
/// Every field is optional — absence means "use the default".
#[derive(Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    /// Overrides the project name (default: the repo root's directory name).
    pub project: Option<String>,
    /// Gap length that splits two heartbeats into separate sessions.
    pub idle_threshold_minutes: Option<u32>,
}

/// Load `.ledger.json` from the repo root, tolerantly: a missing file is
/// the normal case (defaults), and a malformed one must never break a
/// heartbeat — it falls back to defaults and leaves a warning in the error
/// log instead.
pub fn load_config(repo_root: &Path) -> ProjectConfig {
    load_config_from(&repo_root.join(CONFIG_FILE_NAME), errors::log_error)
}

/// Core of `load_config` with the warning sink injected, so tests can
/// capture warnings instead of writing to the real error log.
fn load_config_from(path: &Path, warn: impl FnOnce(&str)) -> ProjectConfig {
    let Ok(contents) = fs::read_to_string(path) else {
        return ProjectConfig::default(); // missing (or unreadable) → defaults
    };
    match serde_json::from_str(&contents) {
        Ok(config) => config,
        Err(e) => {
            warn(&format!("ignoring malformed {}: {e}", path.display()));
            ProjectConfig::default()
        }
    }
}

/// Idle-threshold precedence: CLI flag > project config > built-in default.
pub fn resolve_idle_threshold_minutes(cli_flag: Option<u32>, config: &ProjectConfig) -> u32 {
    cli_flag
        .or(config.idle_threshold_minutes)
        .unwrap_or(DEFAULT_IDLE_THRESHOLD_MINUTES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn valid_config_round_trips_through_serde_json_as_camel_case() {
        let config = ProjectConfig {
            project: Some("acme-api".to_string()),
            idle_threshold_minutes: Some(30),
        };

        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("\"idleThresholdMinutes\":30"), "got {json}");

        let back: ProjectConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, config);
    }

    #[test]
    fn unknown_fields_like_dollar_schema_are_ignored() {
        let json = r#"{"$schema": "./.ledger.schema.json", "project": "acme"}"#;
        let config: ProjectConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.project.as_deref(), Some("acme"));
        assert_eq!(config.idle_threshold_minutes, None);
    }

    #[test]
    fn missing_file_yields_defaults_without_warning() {
        let tmp = tempfile::tempdir().unwrap();
        let warned = RefCell::new(false);

        let config = load_config_from(&tmp.path().join(CONFIG_FILE_NAME), |_| {
            *warned.borrow_mut() = true;
        });

        assert_eq!(config, ProjectConfig::default());
        assert!(!*warned.borrow());
    }

    #[test]
    fn malformed_json_yields_defaults_and_warns() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(CONFIG_FILE_NAME);
        std::fs::write(&path, "{ not json").unwrap();
        let warning = RefCell::new(None);

        let config = load_config_from(&path, |msg| {
            *warning.borrow_mut() = Some(msg.to_string());
        });

        assert_eq!(config, ProjectConfig::default());
        let warning = warning.borrow();
        let warning = warning.as_deref().unwrap();
        assert!(warning.contains("malformed"), "got: {warning}");
        assert!(warning.contains(".ledger.json"), "got: {warning}");
    }

    #[test]
    fn idle_threshold_precedence_is_flag_then_config_then_default() {
        let with = ProjectConfig {
            project: None,
            idle_threshold_minutes: Some(30),
        };
        let without = ProjectConfig::default();

        assert_eq!(resolve_idle_threshold_minutes(Some(5), &with), 5);
        assert_eq!(resolve_idle_threshold_minutes(None, &with), 30);
        assert_eq!(
            resolve_idle_threshold_minutes(None, &without),
            DEFAULT_IDLE_THRESHOLD_MINUTES
        );
    }
}
