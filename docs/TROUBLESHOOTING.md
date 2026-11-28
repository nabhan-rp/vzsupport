# Troubleshooting

## Browser reports a CORS or network error

1. Inspect the browser’s actual page origin, including scheme, `www`/apex host, preview host, and port.
2. Confirm that exact origin is present in `PUBLIC_FORM_ORIGINS`, without a trailing slash or path.
3. Confirm `OPTIONS /api/public/tickets` returns `204` with that exact `Access-Control-Allow-Origin`.
4. Confirm public `/` and the public API paths `/api/public/tickets` and `/api/public/tickets/lookup` are not intercepted by the staff Cloudflare Access application.
5. Confirm the portal is calling the HTTPS URL `https://support.vz.gay/api/public/tickets`.

Do not fix CORS by setting wildcard `*`.

## API returns `403`

- `Origin is not allowed`: add the exact trusted browser origin to `PUBLIC_FORM_ORIGINS`.
- `Human verification failed`: check that the user completed the widget, that the token is fresh, and that Turnstile permits the hostname returned by siteverify.
- Confirm hostname spelling in the Turnstile widget and `TURNSTILE_EXPECTED_HOSTNAMES`. The origin includes scheme; the hostname value does not.

## API returns `400`, `413`, or `415`

- `400`: check required report values, valid email, JSON formatting, and that `targetUrl` is an absolute `http://` or `https://` URL without embedded credentials.
- `413`: shorten the submitted content; the Worker has a 16 KiB request-body cap and the report body has a 10,000-character cap.
- `415`: send `Content-Type: application/json`.

## API returns `503`

- `Ticket database is not configured`: check the D1 binding name `SUPPORT_DB` and Worker deployment.
- `Public ticket verification is not configured`: add the `TURNSTILE_SECRET_KEY` secret and configure `TURNSTILE_EXPECTED_HOSTNAMES`.
- `Staff access is not configured`: set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` before using staff routes.
- Confirm the D1 schema was applied to the same database ID bound to this Worker.

## Staff console loops to login or returns `401`

1. Confirm `/admin` and staff API paths are covered by the intended Access application and policy. The customer portal at `/` and public API paths should not require an interactive Access login.
2. Confirm the Access assertion is present as `cf-access-jwt-assertion` after login.
3. Check `ACCESS_TEAM_DOMAIN` matches the issuer host (team domain only; no `https://` or path).
4. Check `ACCESS_AUD` matches the audience configured for this exact Access application.
5. Check system clock/expiry and do not cache Access-protected HTML or API responses in an intermediary.
6. If the API reports an invalid signature, verify that the Worker can reach the Access certificate endpoint and that token signing configuration is current.

The Worker intentionally fails closed when Access configuration is missing or invalid.

## Ticket request succeeds but the portal does not show success

- Inspect the response status and JSON shape. The portal should require `201` and a non-empty `ticket.reference`.
- Ensure the form is not expecting an older response such as `{ "ok": true }`; the public API returns `{ "ok": true, "ticket": { "id", "reference" } }`.
- Do not create a synthetic local ticket ID as a fallback. Keep the form data and show a retry/error state instead.
- Local browser history is not a status API; it stores only a reference after a confirmed successful creation.
- Public status lookup requires the same email used when creating the ticket. It returns 404 for an incorrect reference/email pair and reveals the submitted report body on a match.

## Worker deployment or schema command fails

- Confirm Wrangler is authenticated to the intended Cloudflare account.
- Confirm the D1 database name and binding are `vz_support_db` and `SUPPORT_DB`.
- Confirm the placeholder ID in `wrangler.jsonc` has been replaced with a real ID from your account.
- Apply `apps/support-worker/schema.sql` to the correct environment (`--local` for local development, `--remote` for production).
- Review `npm run check` and Wrangler dry-run output before deploying. Never paste account tokens or secrets into issues or logs.

## A ticket was created but no one was notified

That is expected in the current implementation: email notifications, inbound replies, attachments, and an SLA workflow are not implemented. Staff must review the protected technician console until those features are deliberately designed and added.
