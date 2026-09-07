import 'dotenv/config';
import { z } from 'zod';
import { SecurityModeSchema } from '@gerald/contracts';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_TEXT_MODEL: z.string().default('gpt-5.6-luna'),
  OPENAI_REALTIME_MODEL: z.string().default('gpt-realtime-2.1-mini'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  GERALD_MASTER_KEY_BASE64: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().default('Gerald <gerald@example.com>'),
  ASSISTANT_EMAIL: z.string().email().default('gerald@example.com'),
  AUTHORIZED_EMAILS: z.string().default('owner@example.com'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().default('http://localhost:3000/api/google/callback'),
  GOOGLE_PUBSUB_AUDIENCE: z.string().optional(),
  CONSOLE_ORIGIN: z.string().url().default('http://localhost:3001'),
  TIMEZONE: z.string().default('America/Los_Angeles'),
  SYSTEM_MODE: SecurityModeSchema.default('NORMAL'),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl?: string;
  redisUrl?: string;
  openAiApiKey?: string;
  models: { text: string; realtime: string; embedding: string };
  masterKeyBase64?: string;
  resend: { webhookSecret?: string; apiKey?: string; fromEmail: string; assistantEmail: string };
  authorizedEmails: readonly string[];
  google: {
    clientId?: string;
    clientSecret?: string;
    redirectUri: string;
    pubSubAudience?: string;
  };
  consoleOrigin: string;
  timezone: string;
  systemMode: z.infer<typeof SecurityModeSchema>;
  limits: {
    runTimeoutMs: number;
    maxModelTurns: number;
    maxToolCalls: number;
    toolTimeoutMs: number;
    maxContextTokens: number;
    activeSessionMinutes: number;
    summaryHours: number;
  };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = EnvSchema.parse(source);
  const authorizedEmails = env.AUTHORIZED_EMAILS.split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (env.NODE_ENV === 'production' && !env.GERALD_MASTER_KEY_BASE64) {
    throw new Error('GERALD_MASTER_KEY_BASE64 is required in production');
  }
  return {
    env: env.NODE_ENV,
    port: env.PORT,
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    ...(env.REDIS_URL ? { redisUrl: env.REDIS_URL } : {}),
    ...(env.OPENAI_API_KEY ? { openAiApiKey: env.OPENAI_API_KEY } : {}),
    models: {
      text: env.OPENAI_TEXT_MODEL,
      realtime: env.OPENAI_REALTIME_MODEL,
      embedding: env.OPENAI_EMBEDDING_MODEL,
    },
    ...(env.GERALD_MASTER_KEY_BASE64 ? { masterKeyBase64: env.GERALD_MASTER_KEY_BASE64 } : {}),
    resend: {
      ...(env.RESEND_WEBHOOK_SECRET ? { webhookSecret: env.RESEND_WEBHOOK_SECRET } : {}),
      ...(env.RESEND_API_KEY ? { apiKey: env.RESEND_API_KEY } : {}),
      fromEmail: env.RESEND_FROM_EMAIL,
      assistantEmail: env.ASSISTANT_EMAIL.toLowerCase(),
    },
    authorizedEmails,
    google: {
      ...(env.GOOGLE_CLIENT_ID ? { clientId: env.GOOGLE_CLIENT_ID } : {}),
      ...(env.GOOGLE_CLIENT_SECRET ? { clientSecret: env.GOOGLE_CLIENT_SECRET } : {}),
      redirectUri: env.GOOGLE_REDIRECT_URI,
      ...(env.GOOGLE_PUBSUB_AUDIENCE ? { pubSubAudience: env.GOOGLE_PUBSUB_AUDIENCE } : {}),
    },
    consoleOrigin: env.CONSOLE_ORIGIN,
    timezone: env.TIMEZONE,
    systemMode: env.SYSTEM_MODE,
    limits: {
      runTimeoutMs: 120_000,
      maxModelTurns: 8,
      maxToolCalls: 12,
      toolTimeoutMs: 20_000,
      maxContextTokens: 32_000,
      activeSessionMinutes: 30,
      summaryHours: 24,
    },
  };
}
