import { z } from 'zod';

export const CONTRACT_VERSION = '1.0';

export const ChannelSchema = z.enum(['text', 'email', 'voice', 'sms']);
export type Channel = z.infer<typeof ChannelSchema>;

export const SecurityModeSchema = z.enum(['NORMAL', 'READ_ONLY', 'LOCKED']);
export type SecurityMode = z.infer<typeof SecurityModeSchema>;

export const AuthenticationStateSchema = z.enum(['unauthenticated', 'authenticated', 'step_up']);
export type AuthenticationState = z.infer<typeof AuthenticationStateSchema>;

export const RiskLevelSchema = z.enum(['none', 'low', 'medium', 'high', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const TaskStateSchema = z.enum(['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const MemoryKindSchema = z.enum(['fact', 'episode', 'entity', 'decision', 'relationship']);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const ToolResultStatusSchema = z.enum([
  'confirmed_success',
  'confirmed_failure',
  'ambiguous',
  'partial_success',
]);
export type ToolResultStatus = z.infer<typeof ToolResultStatusSchema>;

export const PolicyEffectSchema = z.enum([
  'allow',
  'deny',
  'require_authentication',
  'require_clarification',
]);
export type PolicyEffect = z.infer<typeof PolicyEffectSchema>;

export const UntrustedContentSchema = z.object({
  text: z.string(),
  source: z.enum(['quote', 'forward', 'unknown_sender', 'attachment', 'webpage', 'tool_output']),
  trustedAsInstruction: z.literal(false),
});
export type UntrustedContent = z.infer<typeof UntrustedContentSchema>;

export const AttachmentRefSchema = z.object({
  id: z.string().uuid(),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['pending', 'accepted', 'quarantined', 'rejected']),
  extractedText: z.string().optional(),
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

export const ReplyRouteSchema = z.object({
  channel: ChannelSchema,
  destination: z.string().min(1),
  threadId: z.string().optional(),
  inReplyTo: z.string().optional(),
});
export type ReplyRoute = z.infer<typeof ReplyRouteSchema>;

export const ChannelEnvelopeSchema = z.object({
  version: z.literal(CONTRACT_VERSION),
  providerEventId: z.string().min(1),
  channel: ChannelSchema,
  senderIdentity: z.string().min(1),
  authorizedSender: z.boolean(),
  userAuthoredText: z.string(),
  untrustedContent: z.array(UntrustedContentSchema),
  attachments: z.array(AttachmentRefSchema),
  threadId: z.string().optional(),
  timestamp: z.coerce.date(),
  replyRoute: ReplyRouteSchema,
  rawProviderType: z.string().min(1),
});
export type ChannelEnvelope = z.infer<typeof ChannelEnvelopeSchema>;

export const AgentRunRequestSchema = z.object({
  version: z.literal(CONTRACT_VERSION),
  triggerEventId: z.string().min(1),
  userId: z.string().uuid(),
  sessionId: z.string().uuid(),
  channel: ChannelSchema,
  authentication: AuthenticationStateSchema,
  taskId: z.string().uuid().optional(),
  requestedOperation: z.string().min(1),
  envelope: ChannelEnvelopeSchema,
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

export interface Identity {
  userId: string;
  preferredName: string;
  assistantName: string;
  timezone: string;
  authorizedEmails: readonly string[];
  authorizedPhoneNumbers: readonly string[];
  outboundEmailWhitelist: readonly string[];
  outboundPhoneWhitelist: readonly string[];
  securityMode: SecurityMode;
}

export interface RetrievedMemory {
  id: string;
  kind: MemoryKind;
  text: string;
  score: number;
  authoritative: boolean;
  provenance: { sourceId: string; sourceType: string; capturedAt: Date };
}

export interface SourceExcerpt {
  id: string;
  title: string;
  text: string;
  sourceType: 'email' | 'calendar' | 'drive' | 'contact' | 'message';
  authoritative: boolean;
  capturedAt: Date;
}

export interface AgentContext {
  instructions: readonly string[];
  identity: Identity;
  channel: Channel;
  authentication: AuthenticationState;
  compactProfile: readonly string[];
  activeSession: readonly string[];
  task: readonly string[];
  retrievedMemories: readonly RetrievedMemory[];
  sourceExcerpts: readonly SourceExcerpt[];
  liveToolResults: readonly string[];
  estimatedTokens: number;
}

export interface ToolDescriptor<Input = unknown, Output = unknown> {
  name: string;
  version: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  riskLevel: RiskLevel;
  sensitivity: 'public' | 'private' | 'secret';
  requiredAuthentication: AuthenticationState;
  allowedModes: readonly SecurityMode[];
  allowedChannels: readonly Channel[];
  idempotency: 'none' | 'read' | 'write';
  auditRedaction: readonly string[];
}

export interface ToolCall {
  callId: string;
  name: string;
  input: unknown;
}

export interface ToolExecutionResult {
  callId: string;
  toolName: string;
  status: ToolResultStatus;
  output?: unknown;
  errorCode?: string;
  providerId?: string;
  retryable?: boolean;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  ruleIds: readonly string[];
  grantedScope?: readonly string[];
  reason: string;
}

export interface CapabilityGrant {
  id: string;
  toolName: string;
  scope: readonly string[];
  issuedAt: Date;
  expiresAt: Date;
  singleUse: boolean;
  callBinding?: string;
}

export interface ActionReceipt {
  id: string;
  triggerEventId: string;
  action: string;
  target: string;
  sanitizedParameters: Record<string, unknown>;
  authorizationBasis: readonly string[];
  providerIdentifiers: readonly string[];
  outcome: ToolResultStatus;
  reversalMetadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface MemoryMutationProposal {
  id: string;
  kind: MemoryKind;
  text: string;
  provenance: { sourceId: string; sourceType: string };
  confidence: number;
  sensitivity: 'normal' | 'sensitive' | 'secret_like';
  supersedesId?: string;
}

export interface NotificationJob {
  id: string;
  kind: 'reminder' | 'watched_email';
  triggerAt: Date;
  deliveryChannel: 'email';
  recipient: string;
  quietHourPolicy: 'exact' | 'defer_non_urgent';
  deduplicationKey: string;
  minimalFormattingData: Record<string, string>;
  state: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
}

export interface AuditEvent {
  id: string;
  eventType: string;
  actor: 'user' | 'model' | 'worker' | 'connector' | 'system';
  triggerEventId?: string;
  sanitizedData: Record<string, unknown>;
  createdAt: Date;
}

export interface OutboxEntry {
  id: string;
  topic: string;
  key: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  publishedAt?: Date;
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return /(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|Bearer\s+\S+|-----BEGIN)/i.test(value)
      ? '[REDACTED_SECRET]'
      : value;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[
        key.toLowerCase().includes('token') ||
        key.toLowerCase().includes('secret') ||
        key.toLowerCase().includes('key')
          ? '[REDACTED_FIELD]'
          : key
      ] = redactSecrets(item);
    }
    return result;
  }
  return value;
}
