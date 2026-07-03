use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub const CONFIG_FILE_NAME: &str = "config.json";
pub const CREDENTIALS_FILE_NAME: &str = "credentials.json";

pub const CONVEX_URL_ENV_VAR: &str = "LEDGER_CONVEX_URL";
pub const WORKOS_CLIENT_ID_ENV_VAR: &str = "LEDGER_WORKOS_CLIENT_ID";
pub const WORKOS_API_URL_ENV_VAR: &str = "LEDGER_WORKOS_API_URL";

// Baked-in defaults for the hosted backend: the Convex production
// deployment (team fmap-labs, project ledger) and its auto-provisioned
// WorkOS environment's client id (a public identifier, not a secret).
// Env vars and config.json override them either way — see the stage 12 doc
// for the resolution rationale.
const DEFAULT_CONVEX_URL: Option<&str> = Some("https://giant-elk-500.convex.cloud");
const DEFAULT_WORKOS_CLIENT_ID: Option<&str> = Some("client_01KWJ14ZBG6MS30EVTRR2AZ7EX");
const DEFAULT_WORKOS_API_URL: Option<&str> = Some("https://api.workos.com");

/// Machine-scoped settings at `~/.ledger/config.json`. Unlike the per-repo
/// `.ledger.json` this file is created on first use and a malformed file is
/// a hard error, never a silent fallback: regenerating it would mint a new
/// `device_id`, and device identity is what makes sync conflict-free.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Stable per-machine UUID; every heartbeat row this machine creates is
    /// owned by (and only pushed by) this id.
    pub device_id: String,
    /// Human-readable label for this machine, shown by `ledger sync`.
    pub device_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub convex_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workos_client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workos_api_url: Option<String>,
}

/// On-disk shape of config.json: everything optional, so files written by
/// older/newer versions (or hand-edited ones) load as long as they parse.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SettingsFile {
    device_id: Option<String>,
    device_name: Option<String>,
    convex_url: Option<String>,
    workos_client_id: Option<String>,
    workos_api_url: Option<String>,
}

pub fn config_path(ledger_home: &Path) -> PathBuf {
    ledger_home.join(CONFIG_FILE_NAME)
}

pub fn credentials_path(ledger_home: &Path) -> PathBuf {
    ledger_home.join(CREDENTIALS_FILE_NAME)
}

/// Load `~/.ledger/config.json`, creating it (with a fresh device id and
/// this machine's hostname) on first use. The generated identity is written
/// back immediately so every later invocation sees the same `device_id`.
pub fn load_or_init(ledger_home: &Path) -> Result<Settings> {
    let path = config_path(ledger_home);
    let file = match fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str::<SettingsFile>(&contents).with_context(|| {
            format!(
                "malformed {} — fix it by hand (deleting it would discard this machine's device id)",
                path.display()
            )
        })?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => SettingsFile::default(),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };

    let generated_identity = file.device_id.is_none() || file.device_name.is_none();
    let settings = Settings {
        device_id: file
            .device_id
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        device_name: file.device_name.unwrap_or_else(hostname),
        convex_url: file.convex_url,
        workos_client_id: file.workos_client_id,
        workos_api_url: file.workos_api_url,
    };
    if generated_identity {
        let json = serde_json::to_vec_pretty(&settings).expect("settings always serialize");
        write_private_atomic(&path, &json)?;
    }
    Ok(settings)
}

impl Settings {
    /// Convex deployment URL: env > config field > baked-in default.
    pub fn convex_url(&self) -> Result<String> {
        resolve_setting(
            env::var(CONVEX_URL_ENV_VAR).ok(),
            self.convex_url.clone(),
            DEFAULT_CONVEX_URL,
        )
        .with_context(|| missing_setting("Convex URL", CONVEX_URL_ENV_VAR, "convexUrl"))
    }

    pub fn workos_client_id(&self) -> Result<String> {
        resolve_setting(
            env::var(WORKOS_CLIENT_ID_ENV_VAR).ok(),
            self.workos_client_id.clone(),
            DEFAULT_WORKOS_CLIENT_ID,
        )
        .with_context(|| {
            missing_setting(
                "WorkOS client id",
                WORKOS_CLIENT_ID_ENV_VAR,
                "workosClientId",
            )
        })
    }

    pub fn workos_api_url(&self) -> Result<String> {
        resolve_setting(
            env::var(WORKOS_API_URL_ENV_VAR).ok(),
            self.workos_api_url.clone(),
            DEFAULT_WORKOS_API_URL,
        )
        .with_context(|| missing_setting("WorkOS API URL", WORKOS_API_URL_ENV_VAR, "workosApiUrl"))
    }
}

/// Precedence core, env value passed in so it can be tested without touching
/// process-global env vars (same trick as `paths::resolve_home`).
fn resolve_setting(
    env_value: Option<String>,
    config_value: Option<String>,
    default: Option<&str>,
) -> Option<String> {
    env_value
        .filter(|v| !v.is_empty())
        .or(config_value)
        .or_else(|| default.map(String::from))
}

fn missing_setting(what: &str, env_var: &str, config_key: &str) -> String {
    format!("no {what} configured — set {env_var} or \"{config_key}\" in ~/.ledger/config.json")
}

fn hostname() -> String {
    env::var("HOSTNAME")
        .ok()
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .or_else(|| {
            fs::read_to_string("/etc/hostname")
                .ok()
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty())
        })
        .unwrap_or_else(|| "unknown-device".to_string())
}

/// WorkOS tokens for the logged-in account. Absence of the file is the
/// normal logged-out state, not an error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub access_token: String,
    pub refresh_token: String,
    /// Access-token expiry as epoch milliseconds, if known.
    pub expires_at: Option<i64>,
}

pub fn load_credentials(ledger_home: &Path) -> Result<Option<Credentials>> {
    let path = credentials_path(ledger_home);
    match fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map(Some)
            .with_context(|| format!("malformed {} — run `ledger login` again", path.display())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

pub fn save_credentials(ledger_home: &Path, credentials: &Credentials) -> Result<()> {
    let json = serde_json::to_vec_pretty(credentials).expect("credentials always serialize");
    write_private_atomic(&credentials_path(ledger_home), &json)
}

pub fn delete_credentials(ledger_home: &Path) -> Result<()> {
    match fs::remove_file(credentials_path(ledger_home)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()), // already logged out
        Err(e) => Err(e).context("deleting credentials"),
    }
}

/// Write `bytes` to `path` atomically (tmp file + rename) with 0600 perms, so
/// a crash mid-write can never leave a torn or world-readable file. WorkOS
/// rotates refresh tokens, so credentials.json in particular must only ever
/// flip from one complete token pair to the next.
fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .with_context(|| format!("creating {}", tmp.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("writing {}", tmp.display()))?;
    }
    fs::rename(&tmp, path).with_context(|| format!("moving {} into place", tmp.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn temp_home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn creds() -> Credentials {
        Credentials {
            access_token: "at-1".into(),
            refresh_token: "rt-1".into(),
            expires_at: Some(1_700_000_000_000),
        }
    }

    #[test]
    fn first_load_generates_a_device_id_and_later_loads_keep_it() {
        let home = temp_home();
        let first = load_or_init(home.path()).unwrap();
        uuid::Uuid::parse_str(&first.device_id).expect("device id is a uuid");
        assert!(!first.device_name.is_empty());

        let second = load_or_init(home.path()).unwrap();
        assert_eq!(second.device_id, first.device_id);
        assert_eq!(second.device_name, first.device_name);
    }

    #[test]
    fn hand_edited_fields_survive_and_missing_identity_is_backfilled() {
        let home = temp_home();
        fs::write(
            config_path(home.path()),
            r#"{"convexUrl": "https://example.convex.cloud"}"#,
        )
        .unwrap();

        let settings = load_or_init(home.path()).unwrap();
        assert_eq!(
            settings.convex_url.as_deref(),
            Some("https://example.convex.cloud")
        );
        uuid::Uuid::parse_str(&settings.device_id).unwrap();

        // The backfilled identity was persisted, not regenerated per run.
        let again = load_or_init(home.path()).unwrap();
        assert_eq!(again.device_id, settings.device_id);
    }

    #[test]
    fn malformed_config_is_a_hard_error_not_a_silent_regeneration() {
        let home = temp_home();
        fs::write(config_path(home.path()), "{ not json").unwrap();

        let err = load_or_init(home.path()).unwrap_err();
        assert!(err.to_string().contains("malformed"), "got: {err:#}");
        // The broken file must be left in place for the user to fix.
        assert!(
            fs::read_to_string(config_path(home.path()))
                .unwrap()
                .contains("not json")
        );
    }

    #[test]
    fn setting_precedence_is_env_then_config_then_default() {
        let env = Some("from-env".to_string());
        let config = Some("from-config".to_string());
        let default = Some("from-default");

        assert_eq!(
            resolve_setting(env.clone(), config.clone(), default).as_deref(),
            Some("from-env")
        );
        assert_eq!(
            resolve_setting(None, config.clone(), default).as_deref(),
            Some("from-config")
        );
        assert_eq!(
            resolve_setting(None, None, default).as_deref(),
            Some("from-default")
        );
        assert_eq!(resolve_setting(None, None, None), None);
        // Empty env var counts as unset, like LEDGER_HOME does.
        assert_eq!(
            resolve_setting(Some(String::new()), config, default).as_deref(),
            Some("from-config")
        );
    }

    #[test]
    fn credentials_round_trip_and_absence_means_logged_out() {
        let home = temp_home();
        assert_eq!(load_credentials(home.path()).unwrap(), None);

        save_credentials(home.path(), &creds()).unwrap();
        assert_eq!(load_credentials(home.path()).unwrap(), Some(creds()));

        delete_credentials(home.path()).unwrap();
        assert_eq!(load_credentials(home.path()).unwrap(), None);
        delete_credentials(home.path()).unwrap(); // idempotent
    }

    #[test]
    fn credential_writes_are_private_and_leave_no_tmp_file() {
        let home = temp_home();
        save_credentials(home.path(), &creds()).unwrap();

        let path = credentials_path(home.path());
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "mode was {mode:o}");

        let leftovers: Vec<_> = fs::read_dir(home.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "found {leftovers:?}");
    }

    #[test]
    fn saving_over_existing_credentials_replaces_them_atomically() {
        let home = temp_home();
        save_credentials(home.path(), &creds()).unwrap();

        let rotated = Credentials {
            access_token: "at-2".into(),
            refresh_token: "rt-2".into(),
            expires_at: None,
        };
        save_credentials(home.path(), &rotated).unwrap();
        assert_eq!(load_credentials(home.path()).unwrap(), Some(rotated));
    }
}
