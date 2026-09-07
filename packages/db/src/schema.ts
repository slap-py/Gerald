import { relations } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

export const securityMode = pgEnum('security_mode', ['NORMAL', 'READ_ONLY', 'LOCKED']);
export const taskState = pgEnum('task_state', ['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']);
export const memoryKind = pgEnum('memory_kind', [
  'fact',
  'episode',
  'entity',
  'decision',
  'relationship',
]);
export const channel = pgEnum('channel', ['text', 'email', 'voice', 'sms']);
export const authState = pgEnum('auth_state', ['unauthenticated', 'authenticated', 'step_up']);
export const webhookState = pgEnum('webhook_state', [
  'ACCEPTED',
  'REJECTED',
  'PROCESSED',
  'FAILED',
]);
export const notificationState = pgEnum('notification_state', [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
]);

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: id(),
  preferredName: text('preferred_name').notNull(),
  timezone: text('timezone').notNull().default('America/Los_Angeles'),
  securityMode: securityMode('security_mode').notNull().default('NORMAL'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authorizedIdentities = pgTable(
  'authorized_identities',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(),
    normalizedValue: text('normalized_value').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    pinVerifier: text('pin_verifier'),
    failedPinAttempts: integer('failed_pin_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => ({
    identityUnique: uniqueIndex('authorized_identity_value_idx').on(
      table.kind,
      table.normalizedValue,
    ),
  }),
);

export const assistantIdentities = pgTable('assistant_identities', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull().default('Gerald'),
  email: text('email').notNull(),
  createdAt: createdAt(),
});

export const connectedAccounts = pgTable(
  'connected_accounts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    provider: text('provider').notNull(),
    externalAccountId: text('external_account_id').notNull(),
    encryptedRefreshToken: jsonb('encrypted_refresh_token'),
    scopes: text('scopes').array().notNull().default([]),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountUnique: uniqueIndex('connected_account_provider_idx').on(
      table.userId,
      table.provider,
      table.externalAccountId,
    ),
  }),
);

export const conversations = pgTable('conversations', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  channel: channel('channel').notNull(),
  externalThreadId: text('external_thread_id'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable(
  'messages',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    providerMessageId: text('provider_message_id'),
    senderIdentity: text('sender_identity').notNull(),
    userAuthoredText: text('user_authored_text').notNull(),
    untrustedContent: jsonb('untrusted_content').notNull().default([]),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    providerMessageUnique: uniqueIndex('message_provider_id_idx').on(table.providerMessageId),
  }),
);

export const attachments = pgTable('attachments', {
  id: id(),
  messageId: uuid('message_id')
    .notNull()
    .references(() => messages.id),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  sha256: text('sha256').notNull(),
  storageRef: text('storage_ref'),
  status: text('status').notNull(),
  extractedText: text('extracted_text'),
  createdAt: createdAt(),
});

export const activeSessions = pgTable('active_sessions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  channel: channel('channel').notNull(),
  authentication: authState('authentication').notNull().default('unauthenticated'),
  rawTurns: jsonb('raw_turns').notNull().default([]),
  compactSummary: text('compact_summary'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  summaryExpiresAt: timestamp('summary_expires_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const tasks = pgTable('tasks', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  parentTaskId: uuid('parent_task_id'),
  title: text('title').notNull(),
  state: taskState('state').notNull().default('ACTIVE'),
  required: boolean('required').notNull().default(true),
  goal: text('goal'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const taskEvents = pgTable('task_events', {
  id: id(),
  taskId: uuid('task_id')
    .notNull()
    .references(() => tasks.id),
  triggerEventId: text('trigger_event_id').notNull(),
  fromState: taskState('from_state'),
  toState: taskState('to_state').notNull(),
  data: jsonb('data').notNull().default({}),
  createdAt: createdAt(),
});

export const profileFacts = pgTable('profile_facts', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  fact: text('fact').notNull(),
  confidence: real('confidence').notNull(),
  sourceId: text('source_id').notNull(),
  supersededBy: uuid('superseded_by'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const episodes = pgTable('episodes', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  summary: text('summary').notNull(),
  sourceId: text('source_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const entities = pgTable('entities', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  entityType: text('entity_type').notNull(),
  createdAt: createdAt(),
});

export const entityAliases = pgTable('entity_aliases', {
  id: id(),
  entityId: uuid('entity_id')
    .notNull()
    .references(() => entities.id),
  alias: text('alias').notNull(),
});

export const decisions = pgTable('decisions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  decision: text('decision').notNull(),
  rationale: text('rationale'),
  sourceId: text('source_id').notNull(),
  createdAt: createdAt(),
});

export const memoryRelationships = pgTable('memory_relationships', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  fromMemoryId: uuid('from_memory_id').notNull(),
  toMemoryId: uuid('to_memory_id').notNull(),
  relationship: text('relationship').notNull(),
});

export const documents = pgTable('documents', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  provider: text('provider').notNull(),
  externalId: text('external_id').notNull(),
  title: text('title').notNull(),
  sourceUrl: text('source_url'),
  fullText: text('full_text'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const documentChunks = pgTable('document_chunks', {
  id: id(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id),
  ordinal: integer('ordinal').notNull(),
  text: text('text').notNull(),
  searchText: text('search_text').notNull(),
  embedding: vector('embedding', { dimensions: 1536 }),
});

export const authChallenges = pgTable('auth_challenges', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  type: text('type').notNull(),
  challengeHash: text('challenge_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const recoveryCodes = pgTable('recovery_codes', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  verifier: text('verifier').notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const policyRules = pgTable('policy_rules', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  ruleId: text('rule_id').notNull(),
  effect: text('effect').notNull(),
  condition: jsonb('condition').notNull(),
  isActive: boolean('is_active').notNull().default(true),
});

export const toolRuns = pgTable('tool_runs', {
  id: id(),
  triggerEventId: text('trigger_event_id').notNull(),
  toolName: text('tool_name').notNull(),
  input: jsonb('input').notNull(),
  output: jsonb('output'),
  status: text('status').notNull(),
  createdAt: createdAt(),
});

export const auditEvents = pgTable('audit_events', {
  id: id(),
  eventType: text('event_type').notNull(),
  actor: text('actor').notNull(),
  triggerEventId: text('trigger_event_id'),
  sanitizedData: jsonb('sanitized_data').notNull(),
  createdAt: createdAt(),
});

export const actionReceipts = pgTable('action_receipts', {
  id: id(),
  triggerEventId: text('trigger_event_id').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  sanitizedParameters: jsonb('sanitized_parameters').notNull(),
  authorizationBasis: text('authorization_basis').array().notNull().default([]),
  providerIdentifiers: text('provider_identifiers').array().notNull().default([]),
  outcome: text('outcome').notNull(),
  reversalMetadata: jsonb('reversal_metadata'),
  createdAt: createdAt(),
});

export const notificationJobs = pgTable('notification_jobs', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  kind: text('kind').notNull(),
  triggerAt: timestamp('trigger_at', { withTimezone: true }).notNull(),
  deliveryChannel: channel('delivery_channel').notNull().default('email'),
  recipient: text('recipient').notNull(),
  quietHourPolicy: text('quiet_hour_policy').notNull(),
  deduplicationKey: text('deduplication_key').notNull(),
  minimalFormattingData: jsonb('minimal_formatting_data').notNull(),
  state: notificationState('state').notNull().default('PENDING'),
  createdAt: createdAt(),
});

export const webhookReceipts = pgTable(
  'webhook_receipts',
  {
    id: id(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    state: webhookState('state').notNull(),
    payloadHash: text('payload_hash').notNull(),
    receivedAt: createdAt(),
  },
  (table) => ({
    providerEventUnique: uniqueIndex('webhook_provider_event_idx').on(
      table.provider,
      table.providerEventId,
    ),
  }),
);

export const outboxEntries = pgTable('outbox_entries', {
  id: id(),
  topic: text('topic').notNull(),
  messageKey: text('message_key').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: createdAt(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
});

export const userRelations = relations(users, ({ many }) => ({
  identities: many(authorizedIdentities),
  tasks: many(tasks),
  conversations: many(conversations),
}));
export const taskRelations = relations(tasks, ({ one, many }) => ({
  user: one(users, { fields: [tasks.userId], references: [users.id] }),
  events: many(taskEvents),
}));
export const conversationRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
  messages: many(messages),
}));
export const messageRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  attachments: many(attachments),
}));
