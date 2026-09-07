import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { z } from 'zod';
import { loadConfig, type AppConfig } from '@gerald/config';
import {
  generateId,
  hashVerifier,
  PasskeyChallengeService,
  PinAttemptGuard,
  RecoveryCodeService,
  verifyVerifier,
} from '@gerald/security';
import type { Identity } from '@gerald/contracts';
import { AgentRunRequestSchema } from '@gerald/contracts';
import {
  createDevelopmentRuntime,
  type AgentRuntime,
  type ModelProvider,
  OpenAIResponsesProvider,
  type RuntimeState,
  ToolRegistry,
} from '@gerald/runtime';
import {
  EmailWebhookProcessor,
  ResendClient,
  ResendDeliveryProcessor,
  ResendWebhookVerifier,
  canReplyToEmail,
} from '@gerald/email';
import {
  GoogleConnector,
  GoogleOAuthService,
  GooglePubSubVerifier,
  DriveFileGrantService,
  GOOGLE_SCOPES,
  InMemoryGoogleAccountStore,
  GoogleTokenVault,
  OAuthStateStore,
  parseGmailPubSubBody,
  registerGoogleTools,
} from '@gerald/google';

export const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000001';

export interface ApiDependencies {
  config?: AppConfig;
  runtime?: AgentRuntime;
  state?: RuntimeState;
  identity?: Identity;
  emailProcessor?: EmailWebhookProcessor;
  deliveryProcessor?: ResendDeliveryProcessor;
  resendClient?: ResendClient;
  googleOAuth?: GoogleOAuthService;
  googleTokenVault?: GoogleTokenVault;
  googleAccounts?: InMemoryGoogleAccountStore;
  googlePubSub?: GooglePubSubVerifier;
  oauthStates?: OAuthStateStore;
  registry?: ToolRegistry;
  provider?: ModelProvider;
  driveGrants?: DriveFileGrantService;
  consoleAuthenticator?: (request: {
    headers: Record<string, string | string[] | undefined>;
  }) => boolean | Promise<boolean>;
  passkeys?: PasskeyChallengeService;
  recoveryCodes?: RecoveryCodeService;
  passkeyVerifier?: (challenge: string, assertion: unknown) => boolean;
}

export function defaultIdentity(config: AppConfig): Identity {
  return {
    userId: DEFAULT_USER_ID,
    preferredName: 'Owner',
    assistantName: 'Gerald',
    timezone: config.timezone,
    authorizedEmails: config.authorizedEmails,
    authorizedPhoneNumbers: [],
    outboundEmailWhitelist: config.authorizedEmails,
    outboundPhoneWhitelist: [],
    securityMode: config.systemMode,
  };
}

export async function createApi(dependencies: ApiDependencies = {}): Promise<FastifyInstance> {
  const config = dependencies.config ?? loadConfig();
  const identity = dependencies.identity ?? defaultIdentity(config);
  const passkeys = dependencies.passkeys ?? new PasskeyChallengeService();
  const recoveryCodes = dependencies.recoveryCodes ?? new RecoveryCodeService();
  const pinGuard = new PinAttemptGuard();
  let pinVerifier: string | undefined;
  const oauthStates = dependencies.oauthStates ?? new OAuthStateStore();
  const driveGrants = dependencies.driveGrants ?? new DriveFileGrantService();
  const bundle =
    dependencies.runtime && dependencies.state
      ? {
          runtime: dependencies.runtime,
          state: dependencies.state,
          registry: dependencies.registry ?? new ToolRegistry(),
        }
      : createDevelopmentRuntime(
          identity,
          dependencies.provider ??
            (config.openAiApiKey
              ? new OpenAIResponsesProvider(config.models.text, config.openAiApiKey)
              : undefined),
        );
  const app = Fastify({ logger: config.env === 'production', bodyLimit: 12 * 1024 * 1024 });
  await app.register(helmet);
  await app.register(cors, { origin: config.consoleOrigin, credentials: true });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) =>
    done(null, body),
  );
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: 'INVALID_REQUEST', details: error.issues });
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });
  app.addHook('preHandler', async (request, reply) => {
    if (!requiresConsoleAuth(request.url)) return;
    const devHeader = request.headers['x-gerald-dev-auth'];
    const devAuthorized = config.env !== 'production' && devHeader === 'true';
    const customAuthorized = dependencies.consoleAuthenticator
      ? await dependencies.consoleAuthenticator(request)
      : false;
    if (!devAuthorized && !customAuthorized)
      return reply.code(401).send({ error: 'CONSOLE_AUTH_REQUIRED' });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'gerald-api' }));
  app.get('/ready', async (_request, reply) => {
    if (config.env === 'production' && !config.databaseUrl)
      return reply.code(503).send({ status: 'not_ready', reason: 'DATABASE_URL missing' });
    return { status: 'ready' };
  });

  app.post('/api/harness/text', async (request, reply) => {
    const body = z
      .object({
        text: z.string().min(1).max(20_000),
        userId: z.string().uuid().optional(),
        sessionId: z.string().uuid().optional(),
        taskId: z.string().uuid().optional(),
      })
      .parse(parseBody(request.body));
    const runRequest = AgentRunRequestSchema.parse({
      version: '1.0',
      triggerEventId: `harness:${generateId()}`,
      userId: body.userId ?? identity.userId,
      sessionId: body.sessionId ?? generateId(),
      channel: 'text',
      authentication: 'authenticated',
      taskId: body.taskId,
      requestedOperation: 'respond to development text request',
      envelope: {
        version: '1.0',
        providerEventId: `harness:${generateId()}`,
        channel: 'text',
        senderIdentity: identity.userId,
        authorizedSender: true,
        userAuthoredText: body.text,
        untrustedContent: [],
        attachments: [],
        timestamp: new Date(),
        replyRoute: { channel: 'text', destination: identity.userId },
        rawProviderType: 'development.text',
      },
    });
    const result = await bundle.runtime.run(runRequest);
    return reply.send({
      ...result,
      reconstructableAudit: bundle.state.audit
        .list()
        .filter((event) => result.auditEventIds.includes(event.id)),
    });
  });

  app.post('/api/webhooks/resend', async (request, reply) => {
    if (!dependencies.emailProcessor)
      return reply.code(503).send({ error: 'RESEND_NOT_CONFIGURED' });
    const signature = {
      id: header(request, 'svix-id'),
      timestamp: header(request, 'svix-timestamp'),
      signature: header(request, 'svix-signature'),
    };
    const rawBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    let result;
    try {
      result = await dependencies.emailProcessor.process(rawBody, signature);
    } catch (error) {
      if (error instanceof Error && error.message === 'RESEND_INVALID_SIGNATURE')
        return reply.code(401).send({ error: error.message });
      throw error;
    }
    if (result.email && !result.email.envelope.authorizedSender) {
      bundle.state.audit.append({
        eventType: 'email.unknown_sender.stored',
        actor: 'connector',
        sanitizedData: {
          senderIdentity: result.email.envelope.senderIdentity,
          untrustedContent: result.email.envelope.untrustedContent,
        },
      });
    }
    if (result.email?.envelope.authorizedSender) {
      const email = result.email;
      const runRequest = AgentRunRequestSchema.parse({
        version: '1.0',
        triggerEventId: `email:${email.envelope.providerEventId}`,
        userId: identity.userId,
        sessionId: stableSessionId(email.envelope.threadId ?? email.envelope.providerEventId),
        channel: 'email',
        authentication: 'authenticated',
        requestedOperation: 'respond to inbound assistant email',
        envelope: email.envelope,
      });
      const run = await bundle.runtime.run(runRequest);
      if (
        dependencies.resendClient &&
        canReplyToEmail(email.envelope.replyRoute.destination, identity.outboundEmailWhitelist)
      ) {
        await dependencies.resendClient.sendReply({
          from: config.resend.fromEmail,
          to: email.envelope.replyRoute.destination,
          subject: email.subject,
          text: run.text,
          ...(email.envelope.replyRoute.inReplyTo
            ? { inReplyTo: email.envelope.replyRoute.inReplyTo }
            : {}),
          ...(email.headers.references ? { references: email.headers.references } : {}),
        });
      }
      return reply.send({
        accepted: true,
        duplicate: result.duplicate,
        runId: run.auditEventIds[0],
      });
    }
    return reply.send({ accepted: true, duplicate: result.duplicate, triggered: false });
  });

  app.post('/api/webhooks/resend/delivery', async (request, reply) => {
    if (!dependencies.deliveryProcessor)
      return reply.code(503).send({ error: 'RESEND_NOT_CONFIGURED' });
    const signature = {
      id: header(request, 'svix-id'),
      timestamp: header(request, 'svix-timestamp'),
      signature: header(request, 'svix-signature'),
    };
    const rawBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    try {
      return reply.send(await dependencies.deliveryProcessor.process(rawBody, signature));
    } catch (error) {
      if (error instanceof Error && error.message === 'RESEND_INVALID_SIGNATURE')
        return reply.code(401).send({ error: error.message });
      throw error;
    }
  });

  app.get('/api/google/authorize', async (request, reply) => {
    if (!dependencies.googleOAuth) return reply.code(503).send({ error: 'GOOGLE_NOT_CONFIGURED' });
    const query = z.object({ userId: z.string().uuid().optional() }).parse(request.query);
    if (query.userId && query.userId !== identity.userId)
      return reply.code(403).send({ error: 'SINGLE_USER_ONLY' });
    const state = oauthStates.issue(identity.userId);
    return { authorizationUrl: dependencies.googleOAuth.authorizationUrl(state) };
  });

  app.get('/api/google/callback', async (request, reply) => {
    if (!dependencies.googleOAuth || !dependencies.googleTokenVault || !dependencies.googleAccounts)
      return reply.code(503).send({ error: 'GOOGLE_NOT_CONFIGURED' });
    const query = z
      .object({ code: z.string().min(1), state: z.string().min(1) })
      .parse(request.query);
    const userId = identity.userId;
    if (!oauthStates.consume(query.state, userId))
      return reply.code(400).send({ error: 'INVALID_OAUTH_STATE' });
    const tokens = await dependencies.googleOAuth.exchangeCode(query.code);
    const missingScopes = Object.values(GOOGLE_SCOPES).filter(
      (scope) => !tokens.scopes.includes(scope),
    );
    if (missingScopes.length)
      return reply.code(400).send({ error: 'GOOGLE_SCOPES_INCOMPLETE', missingScopes });
    const stored = dependencies.googleTokenVault.seal(tokens, {
      accountId: generateId(),
      userId,
      externalAccountId: tokens.subject,
    });
    await dependencies.googleAccounts.save(stored);
    registerGoogleTools(bundle.registry, new GoogleConnector(tokens));
    bundle.state.audit.append({
      eventType: 'google.account.connected',
      actor: 'connector',
      sanitizedData: { userId, email: tokens.email, scopes: tokens.scopes },
    });
    return { connected: true, email: tokens.email, scopes: tokens.scopes };
  });

  app.get('/api/google/file-grants', async () => ({
    grants: driveGrants.list(bundle.state.identity.userId),
  }));
  app.post('/api/google/file-grants', async (request) => {
    const body = z.object({ fileId: z.string().min(1).max(500) }).parse(parseBody(request.body));
    driveGrants.grant({
      userId: bundle.state.identity.userId,
      fileId: body.fileId,
      grantedAt: new Date(),
      grantedBy: bundle.state.identity.userId,
    });
    bundle.state.audit.append({
      eventType: 'google.drive.file_grant.created',
      actor: 'user',
      sanitizedData: { fileId: body.fileId },
    });
    return { granted: true, fileId: body.fileId };
  });
  app.post('/api/google/revoke', async (_request, reply) => {
    if (!dependencies.googleOAuth || !dependencies.googleTokenVault || !dependencies.googleAccounts)
      return reply.code(503).send({ error: 'GOOGLE_NOT_CONFIGURED' });
    const account = await dependencies.googleAccounts.get(bundle.state.identity.userId);
    if (!account) return reply.code(404).send({ error: 'GOOGLE_ACCOUNT_NOT_FOUND' });
    const tokens = dependencies.googleTokenVault.open(account);
    await dependencies.googleOAuth.revokeToken(tokens.refreshToken ?? tokens.accessToken);
    await dependencies.googleAccounts.revoke(bundle.state.identity.userId);
    bundle.state.audit.append({
      eventType: 'google.account.revoked',
      actor: 'user',
      sanitizedData: { userId: bundle.state.identity.userId },
    });
    return { revoked: true };
  });

  app.post('/api/google/pubsub', async (request, reply) => {
    if (!dependencies.googlePubSub)
      return reply.code(503).send({ error: 'GOOGLE_PUBSUB_NOT_CONFIGURED' });
    const authorization = request.headers.authorization;
    if (!(await dependencies.googlePubSub.verify(authorization ? { authorization } : {})))
      return reply.code(401).send({ error: 'INVALID_PUBSUB_AUTH' });
    const notification = parseGmailPubSubBody(parseBody(request.body));
    bundle.state.outbox.enqueue('gmail.history.sync', notification.emailAddress, {
      emailAddress: notification.emailAddress,
      historyId: notification.historyId,
    });
    return reply.code(204).send();
  });

  app.get('/api/onboarding/passkey/challenge', async () => passkeys.start(identity.userId));
  app.post('/api/onboarding/passkey/finish', async (request, reply) => {
    const body = z
      .object({ challengeId: z.string().uuid(), assertion: z.unknown() })
      .parse(parseBody(request.body));
    const verified = passkeys.consume(
      body.challengeId,
      identity.userId,
      body.assertion,
      dependencies.passkeyVerifier ?? (() => false),
    );
    if (!verified) return reply.code(401).send({ error: 'PASSKEY_ASSERTION_REJECTED' });
    bundle.state.audit.append({
      eventType: 'onboarding.passkey.registered',
      actor: 'user',
      sanitizedData: { userId: identity.userId },
    });
    return { authenticated: true };
  });
  app.post('/api/onboarding/recovery-codes', async (_request, reply) => {
    const codes = await recoveryCodes.issue(identity.userId);
    bundle.state.audit.append({
      eventType: 'security.recovery_codes.issued',
      actor: 'user',
      sanitizedData: { count: codes.length },
    });
    return reply.send({ codes });
  });
  app.post('/api/onboarding/profile', async (request) => {
    const body = z
      .object({
        preferredName: z.string().min(1).max(100),
        assistantName: z.string().min(1).max(100),
        timezone: z.string().min(1),
      })
      .parse(parseBody(request.body));
    bundle.state.identity = { ...bundle.state.identity, ...body };
    bundle.state.audit.append({
      eventType: 'onboarding.profile.updated',
      actor: 'user',
      sanitizedData: body,
    });
    return { updated: true, identity: bundle.state.identity };
  });
  app.post('/api/onboarding/authorized-identities', async (request) => {
    const body = z
      .object({
        email: z.string().email().optional(),
        phoneNumber: z.string().min(7).max(32).optional(),
      })
      .refine((value) => value.email || value.phoneNumber, 'email or phoneNumber is required')
      .parse(parseBody(request.body));
    const nextEmails = body.email
      ? [...bundle.state.identity.authorizedEmails, body.email.toLowerCase()]
      : [...bundle.state.identity.authorizedEmails];
    const nextPhones = body.phoneNumber
      ? [...bundle.state.identity.authorizedPhoneNumbers, body.phoneNumber]
      : [...bundle.state.identity.authorizedPhoneNumbers];
    bundle.state.identity = {
      ...bundle.state.identity,
      authorizedEmails: [...new Set(nextEmails)],
      authorizedPhoneNumbers: [...new Set(nextPhones)],
      outboundEmailWhitelist: [...new Set(nextEmails)],
    };
    bundle.state.audit.append({
      eventType: 'onboarding.identity.added',
      actor: 'user',
      sanitizedData: { emailAdded: Boolean(body.email), phoneAdded: Boolean(body.phoneNumber) },
    });
    return {
      updated: true,
      authorizedEmails: bundle.state.identity.authorizedEmails,
      authorizedPhoneNumbers: bundle.state.identity.authorizedPhoneNumbers,
    };
  });
  app.post('/api/onboarding/pin', async (request) => {
    const body = z.object({ pin: z.string().regex(/^\d{4,12}$/) }).parse(parseBody(request.body));
    pinVerifier = await hashVerifier(body.pin);
    bundle.state.audit.append({
      eventType: 'onboarding.pin.set',
      actor: 'user',
      sanitizedData: { configured: true },
    });
    return { configured: true };
  });
  app.post('/api/security/pin/begin', async (request) => {
    const body = z.object({ callId: z.string().min(1).max(200) }).parse(parseBody(request.body));
    pinGuard.beginCall(body.callId);
    return { started: true };
  });
  app.post('/api/security/pin/verify', async (request, reply) => {
    const body = z
      .object({
        identityKey: z.string().min(1).max(200),
        callId: z.string().min(1).max(200),
        pin: z.string().regex(/^\d{4,12}$/),
      })
      .parse(parseBody(request.body));
    if (!pinVerifier || !pinGuard.canAttempt(body.identityKey, body.callId))
      return reply.code(429).send({ authenticated: false, error: 'PIN_ATTEMPTS_EXHAUSTED' });
    if (!(await verifyVerifier(pinVerifier, body.pin))) {
      pinGuard.recordFailure(body.identityKey, body.callId);
      return reply.code(401).send({ authenticated: false, error: 'PIN_REJECTED' });
    }
    pinGuard.recordSuccess(body.identityKey, body.callId);
    bundle.state.audit.append({
      eventType: 'security.pin.authenticated',
      actor: 'user',
      sanitizedData: { identityKey: body.identityKey, callId: body.callId },
    });
    return { authenticated: true, callBinding: body.callId };
  });
  app.post('/api/security/mode', async (request) => {
    const body = z
      .object({ mode: z.enum(['NORMAL', 'READ_ONLY', 'LOCKED']) })
      .parse(parseBody(request.body));
    bundle.state.identity = { ...bundle.state.identity, securityMode: body.mode };
    bundle.state.audit.append({
      eventType: 'security.mode.changed',
      actor: 'user',
      sanitizedData: body,
    });
    return { mode: body.mode };
  });
  app.get('/api/activity', async () => ({ events: bundle.state.audit.list() }));
  app.get('/api/tasks', async () => ({
    tasks: bundle.state.tasks.tree(bundle.state.identity.userId),
  }));
  app.get('/api/memory', async () => ({
    memories: bundle.state.memory.all(bundle.state.identity.userId),
  }));

  return app;
}

function parseBody(body: unknown): unknown {
  return typeof body === 'string' ? JSON.parse(body) : body;
}
function header(
  request: { headers: Record<string, string | string[] | undefined> },
  name: string,
): string {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
function stableSessionId(seed: string): string {
  const hex = seed
    .replace(/[^a-f0-9]/gi, '')
    .padEnd(32, '0')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function requiresConsoleAuth(url: string): boolean {
  return [
    '/api/onboarding/profile',
    '/api/onboarding/authorized-identities',
    '/api/onboarding/pin',
    '/api/onboarding/recovery-codes',
    '/api/security/mode',
    '/api/security/pin/begin',
    '/api/security/pin/verify',
    '/api/activity',
    '/api/tasks',
    '/api/memory',
    '/api/google/file-grants',
    '/api/google/revoke',
  ].some((route) => url.startsWith(route));
}
