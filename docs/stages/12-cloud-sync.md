# Stage 12: Cloud sync via Convex

Heartbeats recorded on any machine appear in `ledger report` on every
machine. Three new pieces: a Convex backend (in-repo under `cloud/`), account
auth via WorkOS AuthKit's CLI device-authorization flow, and a
device-ownership delta-sync engine in the CLI.

**Sync model**: every row is owned by the `device_id` (a per-machine UUID in
`~/.ledger/config.json`) that created it. Only the owner pushes a row;
other machines pull read-only copies — conflicts are impossible by
construction. Push sends local `dirty = 1` rows; pull follows a cursor over
the server-side `syncedAt` timestamp, which is set by the push mutation so
client clocks never feed cursors.

## Tasks

- [x] `src/settings.rs` — machine-scoped `~/.ledger/config.json`
  (device id + name, endpoint overrides) and `~/.ledger/credentials.json`
  (WorkOS token pair). Atomic 0600 writes; malformed config is a hard error
  (regenerating would mint a new device id); env precedence
  `LEDGER_CONVEX_URL` / `LEDGER_WORKOS_CLIENT_ID` /
  `LEDGER_WORKOS_API_URL` > config field > baked-in default
- [x] `src/db.rs` — versioned migrations via `PRAGMA user_version`; v2 adds
  `uuid` (unique), `device_id`, `dirty` to `heartbeats` plus the
  `sync_state` cursor table, all in one transaction. New sync helpers:
  `select_dirty_batch`, `mark_clean` (optimistic `commit_hash IS ?` guard),
  `apply_pulled_rows` (upsert + cursor, one transaction), `get_pull_cursor`
- [x] `tag_untagged_heartbeats` scoped by `device_id` — the regression this
  stage must not ship without: a local commit must never claim a pulled copy
  of another machine's untagged heartbeat
- [x] `cloud/` Convex backend — `schema.ts` (`heartbeats` indexed by
  `[userId, uuid]` and `[userId, syncedAt]`, `devices`), `sync.ts`
  (`push` upsert mutation, `pull` cursor query with equal-`syncedAt`
  tie-extension and post-cursor `excludeDeviceId` filtering), all functions
  scoped by `ctx.auth.getUserIdentity()`; convex-test + vitest suite
- [x] `cloud/convex/auth.config.ts` — Convex **Custom JWT** providers (not
  plain OIDC: AuthKit access tokens carry no `aud` claim), issuer
  `https://api.workos.com/user_management/<client id>`, JWKS
  `https://api.workos.com/sso/jwks/<client id>`
- [x] `src/cloud/convex.rs` — blocking `ureq` client for Convex's public
  HTTP API (`POST {url}/api/query|mutation`); HTTP 401 becomes
  `ApiError::Unauthorized`, the one failure sync can heal itself
- [x] `src/cloud/auth.rs` — device flow against
  `POST /user_management/authorize/device` + polled
  `POST /user_management/authenticate` (RFC 8628 pacing: `slow_down` adds
  5s); refresh-token rotation persists the new pair **before** returning;
  token expiry read from the JWT `exp` claim for proactive refresh
- [x] `src/cloud/mod.rs` — `sync_all` push/pull loops (batches of 500),
  `with_auth` refresh-and-retry-once on 401, stuck-cursor and
  nothing-cleaned loop guards
- [x] Commands: `ledger login` / `logout` / `sync [--push-only]`; loud,
  like `init`/`report`
- [x] `hook-commit` ends with a best-effort push (2s connect / 5s overall
  timeouts, inside `run_silently`): logged out → silent skip, network down →
  one error-log line, commit always exits 0
- [x] Tests at every layer: db migration/dirty-lifecycle units, settings
  units, httpmock suites for auth/client/engine, convex-test suite for the
  backend, and black-box integration tests (`tests/integration_sync.rs`)
  including the offline-commit safety check
- [x] Provision WorkOS — done via Convex's AuthKit auto-provision
  (`convex.json` `"authKit": {}`): environment, client id, and env vars all
  created against the dev deployment. The `@convex-dev/workos-authkit`
  component is wired in (`convex.config.ts`, `auth.ts`, `http.ts` webhook
  routes) to sync WorkOS users server-side for the future web GUI.
  Confirmed live: the refresh-token grant works with `client_id` alone (no
  `client_secret`) for CLI device-flow sessions, and rotation persists
- [x] Deployment: `npx convex deploy` to production (`giant-elk-500`, with
  its own auto-provisioned WorkOS environment); `DEFAULT_CONVEX_URL` /
  `DEFAULT_WORKOS_CLIENT_ID` in `src/settings.rs` point there. The dev
  deployment (`fast-ermine-429`) remains for `npx convex dev`
- [x] E2E smoke against the real stack: two `LEDGER_HOME`s, device-flow
  login on both, heartbeat + commit under one (post-commit hook pushed to
  Convex in a 0.25s commit), `ledger sync` + `report` under the other
  shows the merged session with its commit hash

## Why the endpoint defaults are compiled in

Settings resolve in three levels (`src/settings.rs`), highest precedence
first:

1. **Env var** — `LEDGER_CONVEX_URL` / `LEDGER_WORKOS_CLIENT_ID` /
   `LEDGER_WORKOS_API_URL`. Ephemeral overrides: the integration tests
   point the binary at httpmock this way, and it's how you'd target a
   staging backend ad hoc.
2. **`~/.ledger/config.json`** — `convexUrl` / `workosClientId`.
   Persistent per-machine override with no env plumbing.
3. **Baked-in `DEFAULT_*` consts** — only when neither of the above is set.

The consts exist because of *who runs the binary and how*: `heartbeat` and
`hook-commit` are invoked by editor plugins and git hooks, which often don't
inherit a shell profile (GUI editors, git GUIs, anything not launched from a
login shell). If the backend address lived only in an env var, the silent
hook push would quietly no-op on any machine where the var didn't reach that
process's environment — invisible by design, since the hook never fails
loudly. Compiled-in defaults make `cargo install` + `ledger login` fully
zero-config regardless of how the process is spawned, the same way `gh`
knows about github.com.

Neither value is a secret: the Convex URL is public by nature and a WorkOS
client id is a public OAuth identifier. The actual secrets
(`WORKOS_API_KEY`, webhook secret) live only on the Convex deployment and in
the gitignored `cloud/.env.local`.

Trade-off: repointing the *default* backend (dev → prod) takes a rebuild.
Acceptable while building from source — and level 2 already covers the
no-rebuild case.

## Development

- `cargo test` — all Rust units + httpmock + integration tests
- `cd cloud && npm test` — convex-test suite
- `cd cloud && CONVEX_AGENT_MODE=anonymous npx convex dev --once` — push
  functions to a local anonymous deployment (used during development;
  `WORKOS_CLIENT_ID` is set to a placeholder there)

## Resources

- [WorkOS CLI Auth](https://workos.com/docs/authkit/cli-auth) — device flow
- [WorkOS AuthKit API — device authorization](https://workos.com/docs/reference/authkit/cli-auth/device-authorization)
- [Convex + AuthKit](https://docs.convex.dev/auth/authkit) — the Custom JWT
  provider shape `auth.config.ts` mirrors
- [Convex HTTP API](https://docs.convex.dev/http-api/) — the
  `/api/query|mutation` envelope the CLI speaks
- [convex-test](https://docs.convex.dev/testing/convex-test)
- [RFC 8628 — OAuth 2.0 Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628)
- [SQLite `PRAGMA user_version`](https://www.sqlite.org/pragma.html#pragma_user_version)
