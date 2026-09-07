# Implementation status

## Phases 1–3

Implemented in this repository:

- pnpm TypeScript monorepo with API, worker, console, shared contracts, config, security, DB, policy, memory, tasks, runtime, Google, and Resend packages.
- PostgreSQL/pgvector schema and migration, outbox abstraction, redacted append-only audit events, runtime limits, structured mock/OpenAI Responses provider boundary, and development text harness.
- Passkey challenge boundary, one-time Argon2id recovery-code service, configurable profile, identity, timezone, and security mode APIs.
- Google OAuth scope set, encrypted token vault, read-only Gmail/Calendar/Drive/Contacts adapters, pagination and quota/revocation handling, Drive file grants, Gmail history cursors, Pub/Sub verification, and deterministic watch renewal.
- Resend/Svix signature verification, event deduplication, authorized-user gating, quote/forward separation, attachment quarantine pipeline, in-thread reply headers, and outbound whitelist enforcement.

## Not enabled yet

Voice, protected Calendar/Docs writes, notification watches, full production WebAuthn ceremony/storage, console page data wiring, and SMS are intentionally reserved for phases 4–8.
