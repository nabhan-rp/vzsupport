# VZ Support

VZ Support is an original Cloudflare Worker-based ticket intake and technician console for the VZ ecosystem. The service is intended for `support.vz.gay`; tickets are stored in D1, technician operations are verified against Cloudflare Access JWTs, and public ticket intake is protected with Turnstile. This initial version covers ticket intake, storage, and technician management; email delivery and attachments are not included.

The repo also contains a Google AI Studio prompt for integrating the existing VZ portal design with the support API. The portal itself is a separate Google AI Studio-connected project and is intentionally not copied or modified here.

## Repository layout

- `apps/support-worker/` — Cloudflare Worker, D1 schema, and focused tests.
- `docs/CLOUDFLARE.md` — Cloudflare resources, Access policy, and deployment setup.
- `GOOGLE-AI-STUDIO-PROMPT.md` — prompt for applying the UI/API integration in the separate VZ portal project.

The local clone directories `vz.gay/`, `cloudfare-crm-assistant-worker/`, and `chatpony/` are ignored by this repo and must remain unchanged. The VZ clone is a visual reference only. The CRM clone has no license file, so its implementation was not copied; this Worker is written for VZ Support from scratch. The Chatpony clone contains only a README and is not included because it describes a commercial license and has no source code here.

## Local checks and development

```sh
npm install
npm run check
npm run dev:support
```

The technician console and staff APIs require a valid Cloudflare Access assertion. The public intake endpoint is `POST /api/public/tickets`; configure Turnstile and CORS origins before using it. See [Cloudflare setup](./docs/CLOUDFLARE.md).

## Deployment

Create your own D1 database, update its placeholder ID and the Access values in [wrangler.jsonc](./apps/support-worker/wrangler.jsonc), add the Turnstile secret, initialize D1 with `schema.sql`, and deploy:

```sh
npm run db:apply:support
npm run deploy:support
```

Do not use the Cloudflare resource IDs from the original CRM repository. Do not commit any Turnstile secret or account credentials.
