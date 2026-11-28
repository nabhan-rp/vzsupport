# Connect the `vz.gay` portal to VZ Support

This guide covers the portal-side connection only. The portal is a separate Google AI Studio-connected project. Its source is not part of this repository, and these instructions do not build, publish, or deploy it.

## Integration model

The portal’s report form submits to the public API over HTTPS:

```text
POST https://support.vz.gay/api/public/tickets
```

The browser request is cross-origin because the page runs on `vz.gay` while the API runs on `support.vz.gay`. The Worker checks that the request’s exact `Origin` is in `PUBLIC_FORM_ORIGINS`, validates the report, verifies the Turnstile token with Cloudflare, and then writes the ticket to D1.

Do not call staff endpoints from portal code. In particular, never call `GET /api/tickets` from the public website.

## Before changing the portal

1. Deploy and configure the support Worker first, following [Cloudflare setup](./CLOUDFLARE.md).
2. Confirm that D1 is initialized with `apps/support-worker/schema.sql`.
3. Configure `PUBLIC_FORM_ORIGINS` with the exact production origin(s) that will host the portal form. Origin includes scheme and hostname, but no path or trailing slash, e.g. `https://vz.gay`.
4. Create a Turnstile widget for the same portal hostname(s). Configure its hostnames in `TURNSTILE_EXPECTED_HOSTNAMES`.
5. Add the Turnstile public site key and API URL to the portal project’s supported environment/build configuration. The site key is public; the secret key belongs only in Worker secrets.
6. If the Google AI Studio preview has a different origin, add that exact origin to `PUBLIC_FORM_ORIGINS` and its hostname to the Turnstile widget/Worker allowlist only while you actively need preview testing. Remove temporary preview origins before production.

Check `https://` variants, `www` vs. apex hostnames, custom preview URLs, and local development separately; they are distinct origins. A CORS origin is not the same value as a Turnstile hostname.

## Portal-side configuration

Use the existing project’s environment-variable mechanism for these public build-time values:

```dotenv
VITE_SUPPORT_API_URL=https://support.vz.gay
VITE_SUPPORT_TURNSTILE_SITE_KEY=your-public-turnstile-site-key
```

These are examples, not secrets. Vite-style `VITE_` values are included in browser bundles. Never use a `VITE_` variable for `TURNSTILE_SECRET_KEY`, Access credentials, Cloudflare account tokens, or any other secret.

The Worker base URL should be configurable rather than duplicated in components. If no environment setting is available in the existing Google AI Studio workflow, use the production Worker URL as a single documented constant and keep it out of unrelated UI code. Do not change the portal’s hosting/build setup just to match this Worker repository.

## Map the existing report form

Keep the current fields, validation, good-faith consent, translations, layout, and email escalation link. On a valid submission, map the data to this request:

```json
{
  "customerName": "Reporter name",
  "reporterEmail": "reporter@example.com",
  "subject": "Abuse / DMCA report: dmca",
  "body": "Evidence and timeline details",
  "category": "dmca",
  "targetUrl": "https://reported.example/path",
  "turnstileToken": "short-lived-token-from-widget"
}
```

| Worker property | Source in existing form |
|---|---|
| `customerName` | Reporter name |
| `reporterEmail` | Contact email |
| `subject` | Short summary, such as a localized report label plus the selected category |
| `body` | Evidence/details; include only information the reporter entered for that purpose |
| `category` | Existing category value, such as `dmca`, `phishing`, or `spam` |
| `targetUrl` | Reported URL |
| `turnstileToken` | Current Turnstile challenge token |

Send `Content-Type: application/json`. Do not send a Turnstile secret, Access JWT, or an account credential from the browser.

## Handle the response and errors

On `201 Created`, the Worker returns:

```json
{
  "ok": true,
  "ticket": {
    "id": 42,
    "reference": "VZ-2026-000042"
  }
}
```

Only after receiving HTTP `201` and a non-empty `ticket.reference`:

- show the existing success state with that reference;
- add the reference to the browser’s local report history; and
- clear the submitted form only if that matches the current form UX.

Do not generate a success-shaped local ID if the request fails. Keep form values available for retry, show a localized error, prevent double submission while the request is in flight, and request a fresh Turnstile token after an expired/used token or a verification error. The Worker stores the record and provides a separate public status lookup at `https://support.vz.gay/`; it does not send an email, so keep the existing email escalation as a fallback.

Expected outcomes:

| HTTP/status | Meaning | Portal behavior |
|---|---|---|
| `201` | Ticket persisted | Show server reference |
| `400` | Invalid/missing fields or JSON | Show validation/retry error |
| `403` | Origin not allowed or Turnstile failed | Explain that verification failed; refresh the challenge |
| `405` | Wrong HTTP method | Treat as integration/configuration error |
| `413` | Request too large | Ask to shorten the report |
| `415` | Content type is not JSON | Treat as integration/configuration error |
| `503` | D1 or required verification configuration missing | Show temporary service unavailable and retain the form |
| Network/CORS failure | API unreachable or origin not allowlisted | Retain form and report temporary connection problem |

Do not log the request body, reporter email, or Turnstile token in browser or Worker logs.

## CORS and Turnstile configuration examples

For the customer portal hosted at `https://support.vz.gay` and an additional portal form hosted at `https://vz.gay` and `https://www.vz.gay`:

```jsonc
"vars": {
  "PUBLIC_FORM_ORIGINS": "https://support.vz.gay,https://vz.gay,https://www.vz.gay",
  "TURNSTILE_EXPECTED_HOSTNAMES": "support.vz.gay,vz.gay,www.vz.gay"
}
```

Replace these examples with the actual hosts. Add an origin to `PUBLIC_FORM_ORIGINS` only when the exact browser origin is trusted; add its hostname to Turnstile’s host allowlist and `TURNSTILE_EXPECTED_HOSTNAMES`. Never use `*` for the public form CORS allowlist.

## Integration acceptance checklist

- [ ] Worker deployed at `https://support.vz.gay`.
- [ ] D1 schema applied to the same database bound to `SUPPORT_DB`.
- [ ] Production portal origins exactly match `PUBLIC_FORM_ORIGINS`.
- [ ] Turnstile widget allows the production hostnames and its secret exists only as a Worker secret.
- [ ] A real successful form submission returns `201` and displays the server-generated ticket reference.
- [ ] Invalid email, missing fields, an invalid URL, failed Turnstile, and an unapproved origin do not create a ticket or show success.
- [ ] A failed API request retains user-entered values and does not add a false ticket to local history.
- [ ] Public portal never calls staff-only list/close routes.
- [ ] Technician routes still require Cloudflare Access.
- [ ] Portal changes are reviewed and released through the separate Google AI Studio project; no portal source/build artifact is added to this repository.
