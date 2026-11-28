# VZ Support production checklist

Use this checklist before pointing the public VZ report form to the Worker. It intentionally keeps the portal release separate.

## Repository and account

- [ ] `nabhan-rp/vzsupport` is private if its operational documentation should not be public.
- [ ] This repository contains no portal source, portal build output, ticket data, secrets, or real Cloudflare credentials.
- [ ] Wrangler is authenticated to the intended Cloudflare account and the `vz.gay` zone is in that account.
- [ ] New Cloudflare resources are created for VZ; no upstream project IDs are reused.

## Worker resources and deployment

- [ ] Create D1 database and set its ID in `apps/support-worker/wrangler.jsonc`.
- [ ] Apply `apps/support-worker/schema.sql` to the intended database.
- [ ] Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` to the values for the staff Access application.
- [ ] Set exact `PUBLIC_FORM_ORIGINS` and `TURNSTILE_EXPECTED_HOSTNAMES` values.
- [ ] Store the Turnstile secret using `wrangler secret put`; do not commit it.
- [ ] Create/assign the `support.vz.gay` custom domain to the Worker.
- [ ] `npm run check` passes.
- [ ] Wrangler dry-run succeeds with expected D1 binding and no copied resource IDs.
- [ ] Deploy the Worker and confirm the public custom domain resolves over HTTPS.

## Access controls

- [ ] Create a Cloudflare Access allow policy for the staff console and APIs, limited to named support staff/groups.
- [ ] Configure Access bypass only for public `/`, `/api/public/tickets`, and `/api/public/tickets/status`; keep `/admin` and staff API routes protected.
- [ ] Confirm Cloudflare Access path matching so public path exceptions do not cover `/admin`, `/api/tickets`, or ticket close routes.
- [ ] Verify `/admin`, `GET /api/tickets`, `POST /api/tickets`, and `POST /api/tickets/:id/close` reject unauthenticated callers at the Worker layer.
- [ ] Test a signed valid Access assertion against the Worker and confirm staff data is visible only after authentication.
- [ ] Add Cloudflare rate limiting for ticket creation and public status lookup; lookup requires the exact reference plus reporter email.

## Public intake

- [ ] Turnstile widget hostnames match the portal’s actual production hosts.
- [ ] Site key is exposed only as a public portal config value; secret key exists only in Worker secrets.
- [ ] Cross-origin preflight succeeds from each approved portal origin.
- [ ] Preflight and POST from an unapproved origin are rejected.
- [ ] Valid test submission creates exactly one D1 row and returns a reference.
- [ ] Public lookup finds a ticket only when both the reference and reporter email match; incorrect combinations return the same not-found response.
- [ ] Invalid challenge, malformed fields, overly large body, malformed email, and unsafe target URL do not create a row.
- [ ] Portal shows success only for a valid `201` response and stores only server-issued references in local history.
- [ ] Portal retry after API/network failure retains the entered report and allows a fresh Turnstile token.

## Privacy and operations

- [ ] Document an appropriate retention period for ticket body and contact details.
- [ ] Restrict D1 access and enable backups/export procedure appropriate to the data.
- [ ] Set a process for reviewing, closing, and responding to incoming tickets; the current Worker does not send email or notify staff.
- [ ] Do not put ticket contents or reporter contact details in test fixtures, CI logs, screenshots, or commits.
- [ ] Deploy/publish the portal separately only after reviewing changes in its Google AI Studio-connected project.
