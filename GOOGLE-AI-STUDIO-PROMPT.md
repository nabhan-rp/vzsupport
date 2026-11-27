# Google AI Studio prompt — VZ Support integration

Paste this prompt into the existing Google AI Studio project for `vz.gay`. The local `vz.gay/` clone in the `vzsupport` workspace is only a design reference; do not copy it into the VZ Support repository or use it to replace the AI Studio project.

---

You are working in the existing Google AI Studio-connected VZ portal project. Use its current UI, typography, colors, Indonesian/English localization, routing, and component conventions as the source of truth. Implement a focused integration between the existing Legal/Abuse/DMCA report form and the separately deployed VZ Support API. Do not redesign unrelated pages or change the project's deployment architecture.

## Required behavior

1. Keep all existing report fields, required-field checks, good-faith consent, localized copy, and keyboard/accessibility behavior.
2. On submission, POST the report to `${VITE_SUPPORT_API_URL}/api/public/tickets` (default the base URL to `https://support.vz.gay` only when the variable is unset).
3. Include a Cloudflare Turnstile widget in the report form. Read its public site key from `VITE_SUPPORT_TURNSTILE_SITE_KEY`; never place the Turnstile secret in browser code.
4. Send JSON with this shape:

   ```json
   {
     "customerName": "Reporter name",
     "reporterEmail": "reporter@example.com",
     "subject": "Short report summary",
     "body": "Evidence and timeline details",
     "category": "dmca",
     "targetUrl": "https://reported.example/path",
     "turnstileToken": "token returned by Turnstile"
   }
   ```

   Map the existing category value, URL, reporter name/email, and details fields to these properties. Make the subject useful and concise; do not duplicate the whole report into it.
5. On HTTP `201`, use the server response's `ticket.reference` as the report ID shown in the success UI and saved to browser history. The response has this shape:

   ```json
   {
     "ok": true,
     "ticket": {
       "id": 42,
       "reference": "VZ-2026-000042"
     }
   }
   ```

6. Never show a success state or save a successful ticket reference when the API fails, returns a non-2xx response, or omits `ticket.reference`. Keep the user's form values available for retry, show a localized actionable error, and allow a fresh Turnstile challenge when needed. Prevent duplicate submission while one request is in flight.
7. Preserve the existing local history UI, but write a history entry only after a successful server response. Keep the existing mail escalation link as a separate fallback.
8. Do not log report details, reporter email, Turnstile tokens, or secrets. Do not add a persistence fallback that pretends a server ticket was created.

## API requirements

- Public endpoint: `POST https://support.vz.gay/api/public/tickets`
- Request header: `Content-Type: application/json`
- The Worker allows browser origins configured in Cloudflare and validates Turnstile server-side.
- Handle validation errors (`400`), failed human verification (`403`), unavailable Worker configuration (`503`), and network failures with localized messages.
- Do not call staff-only endpoints such as `GET /api/tickets` from the public portal.

Inspect the existing project before editing. Make the smallest set of changes needed, follow its established patterns, and run its existing typecheck/build. Summarize changed files and any required Vite environment variables when done.
