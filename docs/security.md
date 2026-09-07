# Security boundaries

- Provider credentials, OAuth refresh tokens, PINs, passkey material, encryption keys, and database credentials never enter `AgentContext` or tool output types.
- OAuth refresh tokens are sealed with AES-256-GCM under `GERALD_MASTER_KEY_BASE64`; PINs and recovery codes use Argon2id verifiers.
- Webhooks are verified before deduplication/persistence. Provider event IDs are durable deduplication keys.
- Forwarded, quoted, unknown-sender, attachment, and tool-returned text is typed as untrusted content and cannot become instructions.
- Normal, Read-only, and Locked mode checks execute outside the model. Read-only blocks Google and email writes; Locked blocks private tools.
- Email replies are limited to the outbound whitelist. Unknown senders are retained as untrusted content and never trigger a run or receive a reply.
- Attachments are size/MIME screened and quarantined by default for dangerous types; malware scanning and extraction must complete before model context inclusion.
- The database audit log is append-only through permissions/triggers. Content deletion is expected to remove source content and derived indexes while retaining a content-free tombstone.
- Call audio is not stored. Voice/SMS are deliberately not enabled in phases 1–3.
