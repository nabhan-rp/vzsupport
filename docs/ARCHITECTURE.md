# VZ Support architecture

## Components and ownership

| Component | Project | Responsibility |
|---|---|---|
| VZ portal | Existing separate Google AI Studio-connected project | Main `vz.gay` site and its existing Legal/Abuse/DMCA UI |
| Support API and technician console | This repository, `apps/support-worker/` | Public ticket intake API and staff-only ticket management |
| Ticket storage | Cloudflare D1 bound as `SUPPORT_DB` | Ticket details, contact fields, status, and creation time |
| Staff authentication | Cloudflare Access | Restrict technician console and staff ticket endpoints |
| Public form challenge | Cloudflare Turnstile | Reduce automated public submissions |

```text
Browser on vz.gay
  ├─ existing portal UI (maintained in Google AI Studio project)
  ├─ Turnstile challenge (public site key)
  └─ HTTPS POST /api/public/tickets
            │ CORS allowlist + server-side Turnstile verification
            ▼
      support.vz.gay Worker
            │ SUPPORT_DB D1 binding
            ▼
        tickets table

Customer at support.vz.gay/
  ├─ POST /api/public/tickets (Turnstile)
  └─ GET /api/public/tickets/lookup (reference + reporter email)

Technician browser
  └─ Cloudflare Access login
       └─ support.vz.gay/admin and /api/tickets
            └─ Worker verifies Access JWT before returning staff data
```

## Separate deployments are intentional

The portal and support Worker have independent source, builds, deployments, and release ownership. The portal sends a browser request to the Worker’s public HTTPS endpoint. It does not need to be copied into this repository, bundled with the Worker, or changed to a Cloudflare Pages Functions project.

This is an HTTP API connection, not a Workers service binding: the browser needs a public HTTPS URL and the API must allow the portal’s exact browser origin. A service binding would only be relevant if a server-side Cloudflare Worker/Pages Function made the API call on behalf of the browser.

The support Worker is configured for the custom domain `support.vz.gay`. That hostname must be available in the Cloudflare account used to deploy the Worker.

## Trust boundaries

- Public `GET /` provides customer ticket creation and status lookup forms. The API has `POST /api/public/tickets` for intake and `GET /api/public/tickets/lookup` for a single ticket lookup; it does not expose a public ticket list.
- Public intake requires a configured exact `Origin`, valid request fields, and a Turnstile token whose verified hostname is allowlisted.
- Public lookup requires a valid ticket reference and matching reporter email; it returns the report body along with the reference, subject, status, and creation time. Apply rate limiting to reduce enumeration attempts.
- Staff routes (`/admin`, `/api/tickets`, and `/api/tickets/:id/close`) require an Access assertion. The Worker verifies the JWT signature and claims; an Access login screen alone is not a substitute for this check.
- Public CORS is not authentication. Non-browser callers can forge an `Origin` header; Turnstile and Cloudflare rate limiting are important additional controls.
- The form should show a ticket reference only after it receives a successful response from the API. Browser history is only a local convenience and is not the system of record.

## Current scope and known omissions

The current Worker supports public ticket creation and lookup, staff ticket creation/listing/closing, D1 storage, Turnstile verification, and an Access-protected technician console. It does not currently send email, support replies or attachments, or provide an SLA/workflow engine. Avoid presenting those as available features until implemented and tested.

The technician API currently returns full ticket details to authenticated staff. Limit Access policies to trusted staff and define retention/backups for D1 before production use.
