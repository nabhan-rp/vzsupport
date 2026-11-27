# VZ Support private documentation

This folder is the implementation and operations guide for VZ Support. Keep these notes in the private `nabhan-rp/vzsupport` repository. Do not copy the VZ portal source into this repository as part of the support integration.

## Guides

- [Architecture and system boundaries](./ARCHITECTURE.md) — how the portal, Worker, D1, Access, and Turnstile fit together.
- [Connect the vz.gay portal](./PORTAL-INTEGRATION.md) — configure the portal-side endpoint and send Abuse/DMCA reports to the support API.
- [Cloudflare setup](./CLOUDFLARE.md) — create resources, set bindings, configure Access and Turnstile, and deploy the Worker.
- [Production checklist](./PRODUCTION-CHECKLIST.md) — sequence and safety checks before enabling the public form.
- [Local development and testing](./LOCAL-DEVELOPMENT.md) — run checks and exercise the Worker without publishing the portal.
- [Troubleshooting](./TROUBLESHOOTING.md) — diagnose common integration and deployment errors.

## Privacy and project boundaries

- `vz.gay` remains a separate Google AI Studio-connected project. Its clone in this workspace is only a design reference; it is not copied, built, deployed, or modified by this repository.
- Portal changes are made in the existing Google AI Studio project using [the integration prompt](../GOOGLE-AI-STUDIO-PROMPT.md). Use its own review, build, and release process when you choose to apply that prompt.
- VZ Support is deployed separately as a Cloudflare Worker at `support.vz.gay`.
- Keep this repository private if these operational notes are intended to remain private. A `docs/` folder by itself does not make repository contents private.
- Never put Cloudflare secrets, live ticket content, reporter information, Turnstile tokens, or real account resource IDs in documentation or commits.
