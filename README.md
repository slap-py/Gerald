# Gerald Personal Agent Harness

Gerald is a private, single-user assistant harness. This repository implements phases 1–3 of the attached plan as a pnpm TypeScript monorepo.

## Quick start

```powershell
pnpm install
Copy-Item .env.example .env
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev:api
```

In a second terminal, exercise the production-shaped text path without credentials:

```powershell
pnpm dev:harness "remember that I prefer concise updates"
```

The API is available on `http://localhost:3000`. Health is `GET /health`; the development text ingress is `POST /api/harness/text` with `{ "text": "..." }`.

## Repository layout

- `apps/api`: Fastify ingress, webhooks, OAuth callbacks, onboarding/security endpoints, and the text harness.
- `apps/worker`: pg-boss worker entrypoint plus deterministic notification primitives.
- `apps/console`: private Next.js console pages for onboarding, activity, tasks, memory, connections, permissions, security, approvals, and health.
- `packages/contracts`: versioned envelopes, run/context/tool/policy/memory/task/audit contracts.
- `packages/runtime`: bounded Responses provider abstraction, tool registry, policy-gated run loop, audit logger, and outbox.
- `packages/db`: Drizzle schema, pgvector migration, and append-only audit trigger.
- `packages/connectors-google`: OAuth, encrypted token vault, read-only Gmail/Calendar/Drive/Contacts tools, Pub/Sub/history/watch handling, and Drive file grants.
- `packages/connectors-email`: Resend/Svix verification, deduplication, trust separation, attachment quarantine, delivery events, and threaded replies.

## Checks

```powershell
pnpm build
pnpm lint
pnpm test
pnpm --dir apps/console build
pnpm format:check
```

Production deployments must supply a 32-byte base64 master key, provider credentials, verified webhook secrets, and an application-specific console authenticator. Voice, protected Google writes, notification watches, and SMS remain disabled until their planned phases.
