# Production deployment

The app has **two** deploy targets that must be provisioned together:

| Target                               | What runs there
| Deployed with     |
| ------------------------------------ |
---------------------------------------------------------------------------------- | ----------------- |
| **Convex** (prod deployment)         | schema, queries/mutations/actions, the WorkOS AuthKit component + webhook receiver | `convex deploy`   |
| **Cloudflare Worker** (`ledger-web`) | the TanStack Start SSR app + static assets                                         | `wrangler deploy` |

The top-level `pnpm deploy` (in this directory) runs both in the correct order.

---

## Variable matrix — where every value lives

Each value has exactly **one** production home. Do not duplicate secrets across homes.

| Variable                   | Home in production                                | Notes
|
| -------------------------- | ------------------------------------------------- |
--------------------------------------------------------------- |
| `VITE_CONVEX_URL`          | **build-time**, injected by `convex deploy --cmd` | prod Convex URL, baked into the
browser bundle. Never hardcode. |
| `VITE_WORKOS_CLIENT_ID`    | **build-time**, `web/.env.production`             | public; inlined into the bundle
|
| `VITE_WORKOS_API_HOSTNAME` | **build-time**, `web/.env.production`             | your WorkOS Custom Authentication
Domain                        |
| `WORKOS_CLIENT_ID`         | **Worker secret** + **Convex env**                | public client id; needed in both runtimes                       |
| `WORKOS_API_KEY`           | **Worker secret** + **Convex env**                | `sk_live_...`                                                   |
| `WORKOS_COOKIE_PASSWORD`   | **Worker secret** only                            | 32+ char random string (`openssl rand -base64 32`)              |
| `WORKOS_REDIRECT_URI`      | **Worker secret** only                            | `https://<prod-domain>/api/auth/callback`                       |
| `WORKOS_ENVIRONMENT_ID`    | **Convex env** only                               | required by `convex/convex.config.ts`                           |
| `WORKOS_WEBHOOK_SECRET`    | **Convex env** only                               | verifies the WorkOS webhook                                     |

- **Worker secrets** are set with `wrangler secret put <NAME>` (run in `web/`) and reach the
  server code through `process.env` (auto-populated because `nodejs_compat` + compat date
  `2025-09-02`).
- **Convex env** is set with `npx convex env set <NAME> <value> --prod` (run in this directory).
- **Build-time** VITE values are inlined by Vite from `web/.env.production` (and the injected
  `VITE_CONVEX_URL`) into the browser bundle. They are public.

---

## One-time production setup

### 1. WorkOS (production / live environment)

In the WorkOS dashboard, in your **production** environment:

- Note the **Client ID**, **API Key** (`sk_live_...`), and **Environment ID**.
- Add the redirect URI `https://<prod-domain>/api/auth/callback`.
- (Recommended) Configure a **Custom Authentication Domain** (e.g. `auth.ledger.dev`) and use it
  as `VITE_WORKOS_API_HOSTNAME`.
- Add a **Webhook** pointing at your prod Convex site domain:
  `https://<prod-convex-name>.convex.site/workos/webhook`, and note its signing secret.
  (You get `<prod-convex-name>` from the first `convex deploy` in step 2.)

### 2. Convex (production deployment + env)

```bash
# From this directory (cloud/). Use a prod deploy key for non-interactive/CI runs:
#   export CONVEX_DEPLOY_KEY=<prod deploy key from the Convex dashboard>

# First deploy creates the prod deployment and prints its URL / name.
npx convex deploy

# Set the deployment env the AuthKit component requires (--prod targets prod):
npx convex env set WORKOS_CLIENT_ID       <live client id>       --prod
npx convex env set WORKOS_API_KEY         <sk_live_...>          --prod
npx convex env set WORKOS_ENVIRONMENT_ID  <environment_...>      --prod
npx convex env set WORKOS_WEBHOOK_SECRET  <webhook signing secret> --prod

# Verify:
npx convex env list --prod
```

> `convex/auth.config.ts` reads `WORKOS_CLIENT_ID` at **push time**, so set the Convex env
> **before** the deploy you rely on (the first deploy just creates the deployment; re-run
> `convex deploy` after setting env, or set env then deploy).

### 3. Cloudflare Worker (secrets + build env)

```bash
cd web

# Runtime secrets for the WorkOS server middleware:
wrangler secret put WORKOS_CLIENT_ID        # public client id
wrangler secret put WORKOS_API_KEY          # sk_live_...
wrangler secret put WORKOS_COOKIE_PASSWORD  # openssl rand -base64 32
wrangler secret put WORKOS_REDIRECT_URI     # https://<prod-domain>/api/auth/callback

# Public build-time values for the browser bundle:
cp .env.production.example .env.production
# then edit .env.production and fill in VITE_WORKOS_CLIENT_ID / VITE_WORKOS_API_HOSTNAME
```

To serve on a custom domain, add a `routes` entry in `web/wrangler.jsonc` (commented example there).

---

## Deploying

From this directory (`cloud/`):

```bash
pnpm deploy
```

This runs `convex deploy` (pushing the backend to prod) and then builds + `wrangler deploy`s the
Worker, with the **prod** `VITE_CONVEX_URL` injected into the build so the browser bundle talks to
the prod backend.

Deploy targets individually if needed:

```bash
pnpm deploy:convex                 # Convex backend only
pnpm --filter web run deploy       # build + deploy the Worker only
```

## Smoke-test the production Worker locally (optional)

```bash
cd web
cp .dev.vars.example .dev.vars     # fill in values (use sk_test_ locally)
vite build
wrangler dev                       # runs the real Worker bundle in workerd
```

## Rollback

- **Worker:** `wrangler rollback` (or `wrangler deployments list` → deploy a prior version).
- **Convex:** redeploy a previous git revision with `convex deploy`.
