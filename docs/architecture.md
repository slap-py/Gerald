# Gerald V1 architecture

Gerald is a private, single-user assistant. `apps/api` is the only general application ingress and `apps/worker` owns durable jobs. The console is a private Next.js surface; it does not expose an agent endpoint.

All channels normalize to the versioned `ChannelEnvelope` contract. The API builds an `AgentRunRequest`, resolves local context, runs the provider-neutral `AgentRuntime`, and appends redacted audit events plus an outbox entry. The development text harness uses this same runtime path.

PostgreSQL is canonical state. `packages/db/drizzle/0000_init.sql` enables pgvector, models identity, conversations, tasks, memory, documents, credentials, webhook receipts, audit events, and outbox entries, and protects audit events with a database trigger. In-memory implementations exist only for local development and tests.

Google adapters are read-only by default. `drive.file` authority is represented by an explicit per-file grant, and the connector never exposes tokens to model context. Resend is an assistant-owned mailbox adapter; only configured user addresses trigger runs or receive replies.
