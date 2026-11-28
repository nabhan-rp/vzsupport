# Cloudflare setup

The support service is one Worker deployed independently from the VZ portal. It uses D1 for tickets, Access for staff authentication, and Turnstile for public ticket intake.

For the portal-side request contract, exact CORS/origin values, preview-host cautions, and success/error handling, see [Connect the vz.gay portal](./PORTAL-INTEGRATION.md). The portal project is separate; these Worker setup steps do not build or publish it.

## 1. Create your Cloudflare resources

From the repository root, authenticate Wrangler and create new resources in your own Cloudflare account:

```sh
npx wrangler login
npx wrangler d1 create vz_support_db
```

Copy the ID returned by Cloudflare into the `d1_databases` section of `apps/support-worker/wrangler.jsonc`. Replace its `REPLACE_WITH_...` placeholder. Never reuse IDs from the upstream CRM clone.

Apply the schema:

```sh
npm run db:apply:support
```

## 2. Configure staff authentication

Create a Cloudflare Access self-hosted application for `support.vz.gay/*` and an allow policy limited to the VZ support staff. Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc` to the team hostname and the Access application audience tag. The Worker validates the assertion signature, issuer, audience, expiry, and email claim; missing configuration fails closed.

The public customer portal and lookup must remain reachable without an interactive staff login. Create specific Access path rules/applications with Bypass for `support.vz.gay/`, `support.vz.gay/api/public/tickets`, and `support.vz.gay/api/public/tickets/lookup`; keep the broader `support.vz.gay/*` application restricted to staff. Confirm path matching and preflight behavior in your Access configuration so only these public routes are bypassed; do not bypass `/admin` or staff API routes. The intake route remains protected by Worker CORS, validation, and server-side Turnstile even when Access login is bypassed. The lookup route requires both ticket reference and reporter email, but also add Cloudflare rate limiting because those values are not a replacement for full account authentication and lookup reveals the report body.

## 3. Configure public intake protection

Create a Turnstile widget that allows `support.vz.gay` for the customer portal here and each hostname used by the separate VZ portal form. Add hostnames to `TURNSTILE_EXPECTED_HOSTNAMES` and matching browser origins to `PUBLIC_FORM_ORIGINS` in `wrangler.jsonc`. The checked-in defaults include `support.vz.gay`, `vz.gay`, and `www.vz.gay`; remove hosts you do not use. Set the public site key in the Worker page and separate VZ portal project; it is not a secret. Confirm the provided site key is configured to allow `support.vz.gay`.

Store the Turnstile secret as a Worker secret:

```sh
npx wrangler secret put TURNSTILE_SECRET_KEY --config apps/support-worker/wrangler.jsonc
```

The Worker accepts only JSON POSTs from the configured `Origin`, limits request size, validates ticket fields, verifies Turnstile server-side, and checks the verification hostname. Add a Cloudflare rate-limiting rule for `POST /api/public/tickets` as an additional anti-abuse layer.

The portal integration prompt documents the request and response shape. A successful response is `201`:

```json
{
  "ok": true,
  "ticket": {
    "id": 42,
    "reference": "VZ-2026-000042"
  }
}
```

## 4. Bind domain and deploy

The Wrangler config declares `support.vz.gay` as a custom domain. Ensure the zone is active in the same Cloudflare account, then run:

```sh
npm run check
npm run deploy:support
```

If custom-domain provisioning is not available yet, use the generated `workers.dev` hostname for a staging deployment and update the public API URL/origins in the separate portal project only after the custom domain is ready.

## Local development notes

- `npm run dev:support` starts Wrangler locally; D1 local state is managed by Wrangler.
- The public customer portal and public ticket endpoints do not require an Access JWT. `/admin`, `/api/tickets`, and `/api/tickets/:id/close` do. For end-to-end staff testing, deploy behind the configured Access application rather than adding an authentication bypass to production code.
- The public ticket endpoint returns clear client errors for invalid input and `503` when required bindings/secrets are not configured.
- The Worker currently stores ticket text and contact details in D1. Configure retention, backups, and access policies appropriate for support data before production use.
