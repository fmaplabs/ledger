use std::time::Duration;

use anyhow::anyhow;
use serde_json::{Value, json};

/// Connect/overall deadlines for one HTTP call. The hook budget is tight on
/// purpose: a best-effort push after `git commit` must never make a commit
/// feel slow, while an interactive `ledger sync` can afford to wait.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub connect: Duration,
    pub overall: Duration,
}

impl Timeouts {
    /// For the loud `ledger sync` command.
    pub fn interactive() -> Self {
        Timeouts {
            connect: Duration::from_secs(10),
            overall: Duration::from_secs(30),
        }
    }

    /// For the silent best-effort push at the end of `hook-commit`.
    pub fn hook() -> Self {
        Timeouts {
            connect: Duration::from_secs(2),
            overall: Duration::from_secs(5),
        }
    }
}

/// HTTP 401 is pulled out of the error soup because it's the one failure the
/// sync engine can fix itself (refresh the token and retry once).
#[derive(Debug)]
pub enum ApiError {
    Unauthorized,
    Other(anyhow::Error),
}

impl From<ApiError> for anyhow::Error {
    fn from(e: ApiError) -> Self {
        match e {
            ApiError::Unauthorized => anyhow!("convex rejected the access token (HTTP 401)"),
            ApiError::Other(e) => e,
        }
    }
}

/// Minimal blocking client for Convex's public HTTP API
/// (`POST {base}/api/query|mutation`). Keeps the whole crate synchronous —
/// no tokio, no official convex crate.
pub struct ConvexClient {
    agent: ureq::Agent,
    base_url: String,
}

impl ConvexClient {
    pub fn new(base_url: &str, timeouts: Timeouts) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_connect(Some(timeouts.connect))
            .timeout_global(Some(timeouts.overall))
            // 4xx/5xx must come back as responses, not transport errors:
            // a 401 body is still a meaningful answer here.
            .http_status_as_error(false)
            .build();
        ConvexClient {
            agent: config.into(),
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    /// Run a Convex query, e.g. `query(token, "sync:pull", json!({...}))`.
    pub fn query(&self, token: &str, path: &str, args: Value) -> Result<Value, ApiError> {
        self.call("query", token, path, args)
    }

    /// Run a Convex mutation, e.g. `mutation(token, "sync:push", json!({...}))`.
    pub fn mutation(&self, token: &str, path: &str, args: Value) -> Result<Value, ApiError> {
        self.call("mutation", token, path, args)
    }

    fn call(&self, kind: &str, token: &str, path: &str, args: Value) -> Result<Value, ApiError> {
        let url = format!("{}/api/{}", self.base_url, kind);
        let mut response = self
            .agent
            .post(&url)
            .header("Authorization", &format!("Bearer {token}"))
            .send_json(json!({ "path": path, "args": args, "format": "json" }))
            .map_err(|e| ApiError::Other(anyhow!(e).context(format!("POST {url}"))))?;

        let status = response.status();
        if status == 401 {
            return Err(ApiError::Unauthorized);
        }
        if !status.is_success() {
            return Err(ApiError::Other(anyhow!("convex returned HTTP {status} for {path}")));
        }

        // 200 carries an envelope: {"status":"success","value":...} or
        // {"status":"error","errorMessage":...}.
        let envelope: Value = response
            .body_mut()
            .read_json()
            .map_err(|e| ApiError::Other(anyhow!(e).context(format!("reading {path} response"))))?;
        match envelope.get("status").and_then(Value::as_str) {
            Some("success") => Ok(envelope
                .get("value")
                .cloned()
                .unwrap_or(Value::Null)),
            Some("error") => {
                let message = envelope
                    .get("errorMessage")
                    .and_then(Value::as_str)
                    .unwrap_or("<no errorMessage>");
                Err(ApiError::Other(anyhow!("convex {path} failed: {message}")))
            }
            _ => Err(ApiError::Other(anyhow!(
                "unexpected convex response for {path}: {envelope}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    fn client(server: &MockServer) -> ConvexClient {
        ConvexClient::new(&server.base_url(), Timeouts::interactive())
    }

    #[test]
    fn mutation_posts_the_convex_envelope_and_returns_the_value() {
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(POST)
                .path("/api/mutation")
                .header("authorization", "Bearer tok-1")
                .json_body(serde_json::json!({
                    "path": "sync:push",
                    "args": { "deviceId": "d1", "rows": [] },
                    "format": "json",
                }));
            then.status(200).json_body(serde_json::json!({
                "status": "success",
                "value": { "upserted": 0, "syncedAt": 42 },
            }));
        });

        let value = client(&server)
            .mutation("tok-1", "sync:push", serde_json::json!({ "deviceId": "d1", "rows": [] }))
            .unwrap();

        mock.assert();
        assert_eq!(value["syncedAt"], 42);
    }

    #[test]
    fn query_hits_the_query_endpoint() {
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(POST).path("/api/query");
            then.status(200)
                .json_body(serde_json::json!({ "status": "success", "value": [1, 2] }));
        });

        let value = client(&server)
            .query("tok", "sync:pull", serde_json::json!({}))
            .unwrap();
        mock.assert();
        assert_eq!(value, serde_json::json!([1, 2]));
    }

    #[test]
    fn application_level_error_envelope_surfaces_the_message() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/api/query");
            then.status(200).json_body(serde_json::json!({
                "status": "error",
                "errorMessage": "Not authenticated",
            }));
        });

        let err = client(&server)
            .query("tok", "sync:pull", serde_json::json!({}))
            .unwrap_err();
        match err {
            ApiError::Other(e) => assert!(e.to_string().contains("Not authenticated"), "got {e:#}"),
            ApiError::Unauthorized => panic!("an error envelope is not a 401"),
        }
    }

    #[test]
    fn http_401_maps_to_unauthorized() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/api/mutation");
            then.status(401).body("Unauthorized");
        });

        let err = client(&server)
            .mutation("stale-token", "sync:push", serde_json::json!({}))
            .unwrap_err();
        assert!(matches!(err, ApiError::Unauthorized));
    }

    #[test]
    fn other_http_errors_carry_the_status() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/api/mutation");
            then.status(560).body("internal");
        });

        let err = client(&server)
            .mutation("tok", "sync:push", serde_json::json!({}))
            .unwrap_err();
        match err {
            ApiError::Other(e) => assert!(e.to_string().contains("560"), "got {e:#}"),
            ApiError::Unauthorized => panic!("560 is not a 401"),
        }
    }
}
