//! WorkOS AuthKit CLI auth: the OAuth device-authorization flow
//! (RFC 8628) plus refresh-token rotation. Verified against the WorkOS docs:
//! `POST /user_management/authorize/device` starts the flow and
//! `POST /user_management/authenticate` (form-encoded) exchanges the device
//! code — and later the refresh token — for a rotated token pair.

use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::Value;

use crate::cloud::convex::Timeouts;
use crate::settings::{self, Credentials, Settings};

const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// Response of `POST /user_management/authorize/device`. `expires_in` and
/// `interval` get RFC 8628's customary values when WorkOS omits them.
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceAuthorization {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    #[serde(default = "default_expires_in")]
    pub expires_in: u64,
    #[serde(default = "default_interval")]
    pub interval: u64,
}

fn default_expires_in() -> u64 {
    300
}

fn default_interval() -> u64 {
    5
}

fn agent(timeouts: Timeouts) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(timeouts.connect))
        .timeout_global(Some(timeouts.overall))
        // OAuth errors (authorization_pending etc.) arrive as HTTP 400
        // with a JSON body — they're answers, not transport failures.
        .http_status_as_error(false)
        .build()
        .into()
}

/// Kick off the device flow: WorkOS mints a user code for the account owner
/// to confirm in a browser.
pub fn start_device_authorization(settings: &Settings) -> Result<DeviceAuthorization> {
    let url = format!(
        "{}/user_management/authorize/device",
        settings.workos_api_url()?.trim_end_matches('/')
    );
    let client_id = settings.workos_client_id()?;
    let mut response = agent(Timeouts::interactive())
        .post(&url)
        .send_form([("client_id", client_id.as_str())])
        .with_context(|| format!("POST {url}"))?;
    if !response.status().is_success() {
        bail!("workos device authorization failed: HTTP {}", response.status());
    }
    response
        .body_mut()
        .read_json()
        .context("parsing device authorization response")
}

/// One outcome of asking WorkOS "has the user confirmed the code yet?".
enum PollOutcome {
    Ready(Credentials),
    Pending,
    SlowDown,
}

/// Poll until the user confirms the device code in their browser, honoring
/// the server's pacing (`slow_down` adds 5s, per RFC 8628).
pub fn poll_for_tokens(settings: &Settings, auth: &DeviceAuthorization) -> Result<Credentials> {
    let url = authenticate_url(settings)?;
    let client_id = settings.workos_client_id()?;
    let agent = agent(Timeouts::interactive());
    let deadline = Instant::now() + Duration::from_secs(auth.expires_in);

    poll_loop(
        auth,
        || {
            let outcome = authenticate(
                &agent,
                &url,
                &[
                    ("grant_type", DEVICE_CODE_GRANT),
                    ("device_code", &auth.device_code),
                    ("client_id", &client_id),
                ],
            )?;
            match outcome {
                AuthenticateOutcome::Tokens(credentials) => Ok(PollOutcome::Ready(credentials)),
                AuthenticateOutcome::OauthError { code, description } => match code.as_str() {
                    "authorization_pending" => Ok(PollOutcome::Pending),
                    "slow_down" => Ok(PollOutcome::SlowDown),
                    "access_denied" => bail!("login was declined in the browser"),
                    "expired_token" => bail!("the login code expired — run `ledger login` again"),
                    other => bail!(
                        "workos rejected the login: {other}{}",
                        description.map(|d| format!(" ({d})")).unwrap_or_default()
                    ),
                },
            }
        },
        std::thread::sleep,
        move || Instant::now() >= deadline,
    )
}

/// The pure pacing loop, with the HTTP attempt, the sleep, and the deadline
/// all injected so tests can drive it instantly.
fn poll_loop(
    auth: &DeviceAuthorization,
    mut attempt: impl FnMut() -> Result<PollOutcome>,
    mut sleep: impl FnMut(Duration),
    mut deadline_passed: impl FnMut() -> bool,
) -> Result<Credentials> {
    let mut interval = Duration::from_secs(auth.interval);
    loop {
        match attempt()? {
            PollOutcome::Ready(credentials) => return Ok(credentials),
            PollOutcome::Pending => {}
            PollOutcome::SlowDown => interval += Duration::from_secs(5),
        }
        if deadline_passed() {
            bail!("the login code expired — run `ledger login` again");
        }
        sleep(interval);
    }
}

/// Exchange the refresh token for a fresh pair. WorkOS ROTATES refresh
/// tokens: the old one is dead the moment this call succeeds, so the new
/// pair is persisted (atomically) before this function returns it.
pub fn refresh(
    settings: &Settings,
    ledger_home: &Path,
    refresh_token: &str,
    timeouts: Timeouts,
) -> Result<Credentials> {
    let url = authenticate_url(settings)?;
    let client_id = settings.workos_client_id()?;
    let outcome = authenticate(
        &agent(timeouts),
        &url,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", &client_id),
        ],
    )?;
    match outcome {
        AuthenticateOutcome::Tokens(credentials) => {
            settings::save_credentials(ledger_home, &credentials)
                .context("persisting rotated tokens")?;
            Ok(credentials)
        }
        AuthenticateOutcome::OauthError { code, .. } if code == "invalid_grant" => {
            bail!("session expired — run `ledger login`")
        }
        AuthenticateOutcome::OauthError { code, description } => bail!(
            "refreshing the session failed: {code}{}",
            description.map(|d| format!(" ({d})")).unwrap_or_default()
        ),
    }
}

/// The access token to use right now: `None` means not logged in (the hook
/// path treats that as "skip sync silently"). A token expiring within 60s is
/// refreshed proactively so it doesn't die mid-batch.
pub fn get_valid_token(
    settings: &Settings,
    ledger_home: &Path,
    timeouts: Timeouts,
) -> Result<Option<String>> {
    let Some(credentials) = settings::load_credentials(ledger_home)? else {
        return Ok(None);
    };
    if let Some(expires_at) = credentials.expires_at {
        let now_ms = chrono::Utc::now().timestamp_millis();
        if now_ms >= expires_at - 60_000 {
            let refreshed = refresh(settings, ledger_home, &credentials.refresh_token, timeouts)?;
            return Ok(Some(refreshed.access_token));
        }
    }
    Ok(Some(credentials.access_token))
}

fn authenticate_url(settings: &Settings) -> Result<String> {
    Ok(format!(
        "{}/user_management/authenticate",
        settings.workos_api_url()?.trim_end_matches('/')
    ))
}

enum AuthenticateOutcome {
    Tokens(Credentials),
    OauthError {
        code: String,
        description: Option<String>,
    },
}

/// One `POST /user_management/authenticate` call. 200 carries the token
/// pair; 4xx carries an OAuth error code the caller interprets.
fn authenticate(
    agent: &ureq::Agent,
    url: &str,
    form: &[(&str, &str)],
) -> Result<AuthenticateOutcome> {
    let mut response = agent
        .post(url)
        .send_form(form.iter().copied())
        .with_context(|| format!("POST {url}"))?;
    let status = response.status();
    let body: Value = response
        .body_mut()
        .read_json()
        .with_context(|| format!("parsing authenticate response (HTTP {status})"))?;

    if status.is_success() {
        let access_token = string_field(&body, "access_token")?;
        let refresh_token = string_field(&body, "refresh_token")?;
        let expires_at = jwt_expiry_ms(&access_token);
        return Ok(AuthenticateOutcome::Tokens(Credentials {
            access_token,
            refresh_token,
            expires_at,
        }));
    }
    match body.get("error").and_then(Value::as_str) {
        Some(code) => Ok(AuthenticateOutcome::OauthError {
            code: code.to_string(),
            description: body
                .get("error_description")
                .and_then(Value::as_str)
                .map(str::to_string),
        }),
        None => bail!("workos authenticate failed: HTTP {status}, body {body}"),
    }
}

fn string_field(body: &Value, field: &str) -> Result<String> {
    body.get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("authenticate response is missing {field}"))
}

/// Read the `exp` claim (seconds) out of a JWT and convert to epoch ms.
/// Decode-only — the server is the one verifying signatures; we just want to
/// know when to refresh. `None` (odd token shape) means "refresh reactively
/// on the first 401" instead.
fn jwt_expiry_ms(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64url_decode(payload)?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    let exp_seconds = claims.get("exp")?.as_i64()?;
    Some(exp_seconds * 1000)
}

fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    fn value_of(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some(u32::from(byte - b'A')),
            b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }
    let input = input.trim_end_matches('=');
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for &byte in input.as_bytes() {
        buffer = (buffer << 6) | value_of(byte)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use std::cell::RefCell;

    fn test_settings(api_url: &str) -> Settings {
        Settings {
            device_id: "device-test".into(),
            device_name: "test-box".into(),
            convex_url: None,
            workos_client_id: Some("client_123".into()),
            workos_api_url: Some(api_url.to_string()),
        }
    }

    fn device_auth() -> DeviceAuthorization {
        DeviceAuthorization {
            device_code: "dev-code".into(),
            user_code: "ABCD-1234".into(),
            verification_uri: "https://auth.example/device".into(),
            verification_uri_complete: "https://auth.example/device?code=ABCD-1234".into(),
            expires_in: 300,
            interval: 5,
        }
    }

    /// A JWT whose payload is just `{"exp": <seconds>}` — signature junk,
    /// which is fine because expiry parsing never verifies.
    fn fake_jwt(exp_seconds: i64) -> String {
        let payload = format!("{{\"exp\":{exp_seconds}}}");
        format!("h.{}.s", base64url_encode(payload.as_bytes()))
    }

    fn base64url_encode(bytes: &[u8]) -> String {
        const ALPHABET: &[u8] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let mut buffer = 0u32;
            for (i, &b) in chunk.iter().enumerate() {
                buffer |= u32::from(b) << (16 - 8 * i);
            }
            for i in 0..=chunk.len() {
                out.push(ALPHABET[((buffer >> (18 - 6 * i)) & 0x3f) as usize] as char);
            }
        }
        out
    }

    #[test]
    fn device_authorization_parses_the_workos_response() {
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(POST)
                .path("/user_management/authorize/device")
                .x_www_form_urlencoded_tuple("client_id", "client_123");
            then.status(200).json_body(serde_json::json!({
                "device_code": "dc-1",
                "user_code": "WXYZ-9876",
                "verification_uri": "https://auth.example/device",
                "verification_uri_complete": "https://auth.example/device?code=WXYZ-9876",
                "expires_in": 600,
                "interval": 7,
            }));
        });

        let auth = start_device_authorization(&test_settings(&server.base_url())).unwrap();
        mock.assert();
        assert_eq!(auth.user_code, "WXYZ-9876");
        assert_eq!(auth.expires_in, 600);
        assert_eq!(auth.interval, 7);
    }

    #[test]
    fn device_authorization_defaults_expiry_and_interval_when_omitted() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/user_management/authorize/device");
            then.status(200).json_body(serde_json::json!({
                "device_code": "dc-1",
                "user_code": "WXYZ-9876",
                "verification_uri": "u",
                "verification_uri_complete": "uc",
            }));
        });

        let auth = start_device_authorization(&test_settings(&server.base_url())).unwrap();
        assert_eq!(auth.expires_in, 300);
        assert_eq!(auth.interval, 5);
    }

    #[test]
    fn poll_loop_waits_through_pending_and_stretches_on_slow_down() {
        let outcomes = RefCell::new(vec![
            PollOutcome::Pending,
            PollOutcome::SlowDown,
            PollOutcome::Pending,
            PollOutcome::Ready(Credentials {
                access_token: "at".into(),
                refresh_token: "rt".into(),
                expires_at: None,
            }),
        ]);
        let sleeps = RefCell::new(Vec::new());

        let credentials = poll_loop(
            &device_auth(),
            || Ok(outcomes.borrow_mut().remove(0)),
            |d| sleeps.borrow_mut().push(d.as_secs()),
            || false,
        )
        .unwrap();

        assert_eq!(credentials.access_token, "at");
        // pending → 5s; slow_down → +5 → 10s; pending → 10s; then ready.
        assert_eq!(*sleeps.borrow(), vec![5, 10, 10]);
    }

    #[test]
    fn poll_loop_gives_up_at_the_deadline() {
        let err = poll_loop(
            &device_auth(),
            || Ok(PollOutcome::Pending),
            |_| {},
            || true, // deadline immediately passed
        )
        .unwrap_err();
        assert!(err.to_string().contains("expired"), "got: {err:#}");
    }

    #[test]
    fn poll_maps_oauth_errors_pending_becomes_a_retry_denied_bails() {
        for (code, expect_contains) in [
            ("access_denied", "declined"),
            ("expired_token", "expired"),
            ("invalid_grant", "invalid_grant"),
        ] {
            let server = MockServer::start();
            server.mock(|when, then| {
                when.method(POST).path("/user_management/authenticate");
                then.status(400)
                    .json_body(serde_json::json!({ "error": code }));
            });
            let settings = test_settings(&server.base_url());
            let mut auth = device_auth();
            auth.expires_in = 0; // pending would bail via deadline, others sooner

            let err = poll_for_tokens(&settings, &auth).unwrap_err();
            assert!(
                err.to_string().contains(expect_contains),
                "for {code}, got: {err:#}"
            );
        }
    }

    #[test]
    fn poll_success_returns_tokens_with_expiry_from_the_jwt() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST)
                .path("/user_management/authenticate")
                .x_www_form_urlencoded_tuple("grant_type", DEVICE_CODE_GRANT)
                .x_www_form_urlencoded_tuple("device_code", "dev-code")
                .x_www_form_urlencoded_tuple("client_id", "client_123");
            then.status(200).json_body(serde_json::json!({
                "access_token": fake_jwt(1_700_000_000),
                "refresh_token": "rt-1",
                "user": { "id": "user_x" },
            }));
        });

        let credentials =
            poll_for_tokens(&test_settings(&server.base_url()), &device_auth()).unwrap();
        assert_eq!(credentials.refresh_token, "rt-1");
        assert_eq!(credentials.expires_at, Some(1_700_000_000_000));
    }

    #[test]
    fn refresh_persists_the_rotated_pair_before_returning() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST)
                .path("/user_management/authenticate")
                .x_www_form_urlencoded_tuple("grant_type", "refresh_token")
                .x_www_form_urlencoded_tuple("refresh_token", "rt-old")
                .x_www_form_urlencoded_tuple("client_id", "client_123");
            then.status(200).json_body(serde_json::json!({
                "access_token": fake_jwt(1_700_000_000),
                "refresh_token": "rt-new",
            }));
        });
        let home = tempfile::tempdir().unwrap();

        let credentials = refresh(
            &test_settings(&server.base_url()),
            home.path(),
            "rt-old",
            Timeouts::interactive(),
        )
        .unwrap();

        assert_eq!(credentials.refresh_token, "rt-new");
        // Rotation means the old token is already dead: the new pair must be
        // on disk by the time refresh() hands it out.
        let persisted = settings::load_credentials(home.path()).unwrap().unwrap();
        assert_eq!(persisted, credentials);
    }

    #[test]
    fn refresh_with_a_dead_token_says_to_log_in_again() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/user_management/authenticate");
            then.status(400)
                .json_body(serde_json::json!({ "error": "invalid_grant" }));
        });
        let home = tempfile::tempdir().unwrap();

        let err = refresh(
            &test_settings(&server.base_url()),
            home.path(),
            "rt-dead",
            Timeouts::interactive(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("ledger login"), "got: {err:#}");
    }

    #[test]
    fn get_valid_token_is_none_when_logged_out() {
        let home = tempfile::tempdir().unwrap();
        let token = get_valid_token(
            &test_settings("http://unused.invalid"),
            home.path(),
            Timeouts::interactive(),
        )
        .unwrap();
        assert_eq!(token, None);
    }

    #[test]
    fn get_valid_token_uses_the_stored_token_while_fresh() {
        let home = tempfile::tempdir().unwrap();
        let far_future = chrono::Utc::now().timestamp_millis() + 3_600_000;
        settings::save_credentials(
            home.path(),
            &Credentials {
                access_token: "at-fresh".into(),
                refresh_token: "rt".into(),
                expires_at: Some(far_future),
            },
        )
        .unwrap();

        // No server at this URL: a network call here would fail the test.
        let token = get_valid_token(
            &test_settings("http://unused.invalid"),
            home.path(),
            Timeouts::interactive(),
        )
        .unwrap();
        assert_eq!(token.as_deref(), Some("at-fresh"));
    }

    #[test]
    fn get_valid_token_refreshes_proactively_when_expiring() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST)
                .path("/user_management/authenticate")
                .x_www_form_urlencoded_tuple("grant_type", "refresh_token");
            then.status(200).json_body(serde_json::json!({
                "access_token": fake_jwt(1_700_000_000),
                "refresh_token": "rt-new",
            }));
        });
        let home = tempfile::tempdir().unwrap();
        settings::save_credentials(
            home.path(),
            &Credentials {
                access_token: "at-stale".into(),
                refresh_token: "rt-old".into(),
                // Inside the 60s skew window → proactive refresh.
                expires_at: Some(chrono::Utc::now().timestamp_millis() + 30_000),
            },
        )
        .unwrap();

        let token = get_valid_token(
            &test_settings(&server.base_url()),
            home.path(),
            Timeouts::interactive(),
        )
        .unwrap();
        assert_eq!(token.as_deref(), Some(&fake_jwt(1_700_000_000)[..]));
        let persisted = settings::load_credentials(home.path()).unwrap().unwrap();
        assert_eq!(persisted.refresh_token, "rt-new");
    }

    #[test]
    fn jwt_expiry_survives_round_trip_and_rejects_junk() {
        assert_eq!(jwt_expiry_ms(&fake_jwt(1_700_000_000)), Some(1_700_000_000_000));
        assert_eq!(jwt_expiry_ms("not-a-jwt"), None);
        assert_eq!(jwt_expiry_ms("a.!!!.c"), None);
    }
}
