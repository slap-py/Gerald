import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SourceExcerpt, ToolDescriptor } from '@gerald/contracts';
import { generateId, SecretCipher, type EncryptedSecret } from '@gerald/security';
import type { RegisteredTool, ToolRegistry } from '@gerald/runtime';

export const GOOGLE_SCOPES = {
  gmailRead: 'https://www.googleapis.com/auth/gmail.readonly',
  calendarRead: 'https://www.googleapis.com/auth/calendar.readonly',
  driveRead: 'https://www.googleapis.com/auth/drive.readonly',
  driveFileWrite: 'https://www.googleapis.com/auth/drive.file',
  contactsRead: 'https://www.googleapis.com/auth/contacts.readonly',
} as const;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface GoogleTokenPayload {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: readonly string[];
}

export interface StoredGoogleTokens {
  accountId: string;
  userId: string;
  externalAccountId: string;
  encrypted: EncryptedSecret;
  scopes: readonly string[];
  revokedAt?: Date;
}

export class GoogleOAuthService {
  constructor(
    private readonly config: GoogleOAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  authorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      state,
      scope: Object.values(GOOGLE_SCOPES).join(' '),
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
  ): Promise<GoogleTokenPayload & { email: string; subject: string }> {
    const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!response.ok) throw new Error(`Google OAuth token exchange failed: ${response.status}`);
    const token = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };
    const profileResponse = await this.fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    if (!profileResponse.ok)
      throw new Error(`Google profile lookup failed: ${profileResponse.status}`);
    const profile = (await profileResponse.json()) as { email?: string; sub?: string };
    if (!profile.email || !profile.sub) throw new Error('Google account profile was incomplete');
    return {
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      expiresAt: Date.now() + token.expires_in * 1000,
      scopes: (token.scope ?? '').split(' ').filter(Boolean),
      email: profile.email,
      subject: profile.sub,
    };
  }

  async refreshAccessToken(
    refreshToken: string,
    scopes: readonly string[],
  ): Promise<GoogleTokenPayload> {
    const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'refresh_token',
      }),
    });
    if (response.status === 400) throw new GoogleRevokedError();
    if (!response.ok) throw new Error(`Google OAuth refresh failed: ${response.status}`);
    const token = (await response.json()) as {
      access_token: string;
      expires_in: number;
      scope?: string;
    };
    return {
      accessToken: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
      scopes: token.scope?.split(' ').filter(Boolean) ?? scopes,
    };
  }

  async revokeToken(token: string): Promise<void> {
    const response = await this.fetchImpl(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
      { method: 'POST' },
    );
    if (!response.ok) throw new Error(`Google token revocation failed: ${response.status}`);
  }
}

export class GoogleTokenVault {
  constructor(private readonly cipher: SecretCipher) {}

  seal(
    payload: GoogleTokenPayload,
    metadata: Omit<StoredGoogleTokens, 'encrypted' | 'scopes' | 'revokedAt'>,
  ): StoredGoogleTokens {
    return {
      ...metadata,
      encrypted: this.cipher.encrypt(JSON.stringify(payload)),
      scopes: payload.scopes,
    };
  }

  open(stored: StoredGoogleTokens): GoogleTokenPayload {
    return JSON.parse(this.cipher.decrypt(stored.encrypted)) as GoogleTokenPayload;
  }
}

export interface GoogleAccountStore {
  save(account: StoredGoogleTokens): Promise<void>;
  get(userId: string): Promise<StoredGoogleTokens | undefined>;
  revoke(userId: string): Promise<void>;
}

export class InMemoryGoogleAccountStore implements GoogleAccountStore {
  private readonly accounts = new Map<string, StoredGoogleTokens>();
  async save(account: StoredGoogleTokens): Promise<void> {
    this.accounts.set(account.userId, account);
  }
  async get(userId: string): Promise<StoredGoogleTokens | undefined> {
    return this.accounts.get(userId);
  }
  async revoke(userId: string): Promise<void> {
    const account = this.accounts.get(userId);
    if (account) account.revokedAt = new Date();
  }
}

export interface GoogleRequestOptions {
  pageToken?: string;
  query?: string;
}

export interface GoogleListResult<T> {
  items: T[];
  nextPageToken?: string;
}

export class GoogleQuotaError extends Error {
  constructor(public readonly retryAfterMs = 5_000) {
    super('GOOGLE_QUOTA');
  }
}
export class GoogleRevokedError extends Error {
  constructor() {
    super('GOOGLE_REVOKED');
  }
}
export class GmailHistoryCursorExpiredError extends Error {
  constructor() {
    super('GMAIL_HISTORY_CURSOR_EXPIRED');
  }
}

export class GoogleConnector {
  constructor(
    private readonly tokens: GoogleTokenPayload,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async searchGmailThreads(
    options: GoogleRequestOptions = {},
  ): Promise<GoogleListResult<{ id: string; snippet?: string }>> {
    return this.list('/gmail/v1/users/me/threads', {
      q: options.query,
      pageToken: options.pageToken,
      maxResults: '20',
    });
  }

  async readGmailThread(threadId: string): Promise<unknown> {
    return this.request(
      `/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata`,
    );
  }

  async searchCalendar(
    options: GoogleRequestOptions = {},
  ): Promise<GoogleListResult<{ id: string; summary?: string; start?: unknown; end?: unknown }>> {
    return this.list('/calendar/v3/calendars/primary/events', {
      q: options.query,
      pageToken: options.pageToken,
      maxResults: '20',
      singleEvents: 'true',
      orderBy: 'startTime',
    });
  }

  async readCalendarEvent(eventId: string): Promise<unknown> {
    return this.request(`/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`);
  }

  async searchDrive(
    options: GoogleRequestOptions = {},
  ): Promise<
    GoogleListResult<{ id: string; name: string; mimeType: string; modifiedTime?: string }>
  > {
    return this.list('/drive/v3/files', {
      q: options.query ?? 'trashed = false',
      pageToken: options.pageToken,
      pageSize: '20',
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)',
    });
  }

  async readDriveFile(fileId: string): Promise<unknown> {
    return this.request(
      `/drive/v3/files/${encodeURIComponent(fileId)}?alt=json&fields=id,name,mimeType,modifiedTime,webViewLink,description`,
    );
  }

  async startGmailWatch(topicName: string): Promise<{ historyId: string; expiration: string }> {
    const response = await this.fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.tokens.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ topicName }),
    });
    if (response.status === 401) throw new GoogleRevokedError();
    if (response.status === 403 || response.status === 429) throw new GoogleQuotaError();
    if (!response.ok) throw new Error(`GMAIL_WATCH_${response.status}`);
    return response.json() as Promise<{ historyId: string; expiration: string }>;
  }

  async historySince(historyId: string): Promise<{
    history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
    historyId: string;
  }> {
    const response = await this.fetchImpl(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(historyId)}&historyTypes=messageAdded`,
      { headers: { authorization: `Bearer ${this.tokens.accessToken}` } },
    );
    if (response.status === 404) throw new GmailHistoryCursorExpiredError();
    if (response.status === 401) throw new GoogleRevokedError();
    if (response.status === 403 || response.status === 429) throw new GoogleQuotaError();
    if (!response.ok) throw new Error(`GMAIL_HISTORY_${response.status}`);
    return response.json() as Promise<{
      history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
      historyId: string;
    }>;
  }

  async searchContacts(
    query: string,
  ): Promise<
    GoogleListResult<{ resourceName: string; names?: unknown[]; emailAddresses?: unknown[] }>
  > {
    return this.list('/people/v1/people/me/connections', {
      query,
      pageSize: '20',
      personFields: 'names,emailAddresses',
    });
  }

  async asSourceExcerpts(query: string): Promise<SourceExcerpt[]> {
    const [gmail, calendar, drive, contacts] = await Promise.all([
      this.searchGmailThreads({ query }),
      this.searchCalendar({ query }),
      this.searchDrive({ query: `name contains '${escapeDriveQuery(query)}'` }),
      this.searchContacts(query),
    ]);
    return [
      ...gmail.items.map((item) => ({
        id: `gmail:${item.id}`,
        title: 'Gmail thread',
        text: item.snippet ?? '',
        sourceType: 'email' as const,
        authoritative: true,
        capturedAt: new Date(),
      })),
      ...calendar.items.map((item) => ({
        id: `calendar:${item.id}`,
        title: item.summary ?? 'Calendar event',
        text: JSON.stringify({ start: item.start, end: item.end }),
        sourceType: 'calendar' as const,
        authoritative: true,
        capturedAt: new Date(),
      })),
      ...drive.items.map((item) => ({
        id: `drive:${item.id}`,
        title: item.name,
        text: `${item.name} (${item.mimeType})`,
        sourceType: 'drive' as const,
        authoritative: true,
        capturedAt: new Date(item.modifiedTime ?? Date.now()),
      })),
      ...contacts.items.map((item) => ({
        id: `contact:${item.resourceName}`,
        title: 'Google contact',
        text: JSON.stringify(item),
        sourceType: 'contact' as const,
        authoritative: true,
        capturedAt: new Date(),
      })),
    ];
  }

  private async list<T>(
    path: string,
    params: Record<string, string | undefined>,
  ): Promise<GoogleListResult<T>> {
    const data = (await this.request(
      `${path}?${new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === 'string')).toString()}`,
    )) as { items?: T[]; files?: T[]; connections?: T[]; nextPageToken?: string };
    return {
      items: data.items ?? data.files ?? data.connections ?? [],
      ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}),
    };
  }

  private async request(path: string): Promise<unknown> {
    if (this.tokens.expiresAt < Date.now()) throw new Error('GOOGLE_ACCESS_TOKEN_EXPIRED');
    const response = await this.fetchImpl(`https://www.googleapis.com${path}`, {
      headers: { authorization: `Bearer ${this.tokens.accessToken}` },
    });
    if (response.status === 401) throw new GoogleRevokedError();
    if (response.status === 403 || response.status === 429) throw new GoogleQuotaError();
    if (!response.ok) throw new Error(`GOOGLE_REQUEST_${response.status}`);
    return response.json();
  }
}

export interface GmailCursorStore {
  get(userId: string): Promise<string | undefined>;
  set(userId: string, historyId: string): Promise<void>;
}

export class InMemoryGmailCursorStore implements GmailCursorStore {
  private readonly cursors = new Map<string, string>();
  async get(userId: string): Promise<string | undefined> {
    return this.cursors.get(userId);
  }
  async set(userId: string, historyId: string): Promise<void> {
    this.cursors.set(userId, historyId);
  }
}

export async function syncGmailHistory(
  userId: string,
  connector: GoogleConnector,
  cursorStore: GmailCursorStore,
  fetchImpl: typeof fetch = fetch,
): Promise<{ messageIds: string[]; historyId: string }> {
  const startHistoryId = await cursorStore.get(userId);
  if (!startHistoryId) throw new GmailHistoryCursorExpiredError();
  const body =
    fetchImpl === fetch
      ? await connector.historySince(startHistoryId)
      : await readHistoryWithFetch(fetchImpl, startHistoryId);
  if (!body.historyId) throw new Error('GMAIL_HISTORY_MISSING_CURSOR');
  await cursorStore.set(userId, body.historyId);
  return {
    messageIds: (body.history ?? []).flatMap((item) =>
      (item.messagesAdded ?? []).map((message) => message.message.id),
    ),
    historyId: body.historyId,
  };
}

export interface GmailWatchManagerOptions {
  topicName: string;
  renewalWindowMs?: number;
}
export class GmailWatchManager {
  constructor(private readonly options: GmailWatchManagerOptions) {}
  async watch(connector: GoogleConnector): Promise<{ historyId: string; expiration: Date }> {
    const response = await connector.startGmailWatch(this.options.topicName);
    return { historyId: response.historyId, expiration: new Date(response.expiration) };
  }
  shouldRenew(expiration: Date, now = new Date()): boolean {
    return (
      expiration.getTime() - now.getTime() <= (this.options.renewalWindowMs ?? 24 * 60 * 60 * 1000)
    );
  }
}

export interface DriveFileGrant {
  userId: string;
  fileId: string;
  grantedAt: Date;
  grantedBy: string;
}
export class DriveFileGrantService {
  private readonly grants = new Map<string, DriveFileGrant>();
  grant(grant: DriveFileGrant): void {
    this.grants.set(`${grant.userId}:${grant.fileId}`, grant);
  }
  canWrite(userId: string, fileId: string): boolean {
    return this.grants.has(`${userId}:${fileId}`);
  }
  list(userId: string): DriveFileGrant[] {
    return [...this.grants.values()].filter((grant) => grant.userId === userId);
  }
}

export function googleToolDescriptors(): readonly ToolDescriptor[] {
  const inputSchema = z.object({
    query: z.string().min(1).max(500),
    pageToken: z.string().max(1000).optional(),
  });
  const outputSchema = z.object({
    items: z.array(z.unknown()),
    nextPageToken: z.string().optional(),
  });
  const common = {
    version: '1.0',
    inputSchema,
    outputSchema,
    riskLevel: 'low' as const,
    sensitivity: 'private' as const,
    requiredAuthentication: 'authenticated' as const,
    allowedModes: ['NORMAL', 'READ_ONLY'] as const,
    allowedChannels: ['text', 'email', 'voice', 'sms'] as const,
    idempotency: 'read' as const,
    auditRedaction: ['accessToken', 'refreshToken'],
  };
  const readInput = z.object({ id: z.string().min(1).max(500) });
  const readOutput = z.unknown();
  return [
    {
      ...common,
      name: 'google.gmail.search_threads',
      description: 'Search the connected Gmail account for threads.',
    },
    {
      ...common,
      name: 'google.gmail.read_thread',
      description: 'Read metadata and safe content for one Gmail thread.',
      inputSchema: readInput,
      outputSchema: readOutput,
    },
    {
      ...common,
      name: 'google.calendar.search_events',
      description: 'Search the connected primary Google Calendar.',
    },
    {
      ...common,
      name: 'google.calendar.read_event',
      description: 'Read one Calendar event.',
      inputSchema: readInput,
      outputSchema: readOutput,
    },
    {
      ...common,
      name: 'google.drive.search_files',
      description: 'Search the connected Google Drive read-only index.',
    },
    {
      ...common,
      name: 'google.drive.read_file',
      description: 'Read metadata for one Drive file.',
      inputSchema: readInput,
      outputSchema: readOutput,
    },
    { ...common, name: 'google.contacts.search', description: 'Search read-only Google contacts.' },
  ];
}

export function registerGoogleTools(registry: ToolRegistry, connector: GoogleConnector): void {
  const searchInput = z.object({
    query: z.string().min(1).max(500),
    pageToken: z.string().max(1000).optional(),
  });
  const idInput = z.object({ id: z.string().min(1).max(500) });
  const output = z.unknown();
  const common = {
    version: '1.0',
    riskLevel: 'low' as const,
    sensitivity: 'private' as const,
    requiredAuthentication: 'authenticated' as const,
    allowedModes: ['NORMAL', 'READ_ONLY'] as const,
    allowedChannels: ['text', 'email', 'voice', 'sms'] as const,
    idempotency: 'read' as const,
    auditRedaction: ['accessToken', 'refreshToken'],
  };
  const tools: RegisteredTool[] = [
    {
      descriptor: {
        ...common,
        name: 'google.gmail.search_threads',
        description: 'Search the connected Gmail account for threads.',
        inputSchema: searchInput,
        outputSchema: output,
      },
      execute: async (input) =>
        connector.searchGmailThreads(normalizeSearchInput(searchInput.parse(input))),
    },
    {
      descriptor: {
        ...common,
        name: 'google.gmail.read_thread',
        description: 'Read one Gmail thread.',
        inputSchema: idInput,
        outputSchema: output,
      },
      execute: async (input) => connector.readGmailThread(idInput.parse(input).id),
    },
    {
      descriptor: {
        ...common,
        name: 'google.calendar.search_events',
        description: 'Search the connected primary Google Calendar.',
        inputSchema: searchInput,
        outputSchema: output,
      },
      execute: async (input) =>
        connector.searchCalendar(normalizeSearchInput(searchInput.parse(input))),
    },
    {
      descriptor: {
        ...common,
        name: 'google.calendar.read_event',
        description: 'Read one Calendar event.',
        inputSchema: idInput,
        outputSchema: output,
      },
      execute: async (input) => connector.readCalendarEvent(idInput.parse(input).id),
    },
    {
      descriptor: {
        ...common,
        name: 'google.drive.search_files',
        description: 'Search the connected Google Drive read-only index.',
        inputSchema: searchInput,
        outputSchema: output,
      },
      execute: async (input) =>
        connector.searchDrive(normalizeSearchInput(searchInput.parse(input))),
    },
    {
      descriptor: {
        ...common,
        name: 'google.drive.read_file',
        description: 'Read one Drive file metadata record.',
        inputSchema: idInput,
        outputSchema: output,
      },
      execute: async (input) => connector.readDriveFile(idInput.parse(input).id),
    },
    {
      descriptor: {
        ...common,
        name: 'google.contacts.search',
        description: 'Search read-only Google contacts.',
        inputSchema: searchInput,
        outputSchema: output,
      },
      execute: async (input) => connector.searchContacts(searchInput.parse(input).query),
    },
  ];
  for (const tool of tools) if (!registry.has(tool.descriptor.name)) registry.register(tool);
}

export class OAuthStateStore {
  private readonly values = new Map<string, { userId: string; expiresAt: number }>();
  issue(userId: string, now = Date.now()): string {
    const state = generateId();
    this.values.set(state, { userId, expiresAt: now + 10 * 60 * 1000 });
    return state;
  }
  consume(state: string, userId: string, now = Date.now()): boolean {
    const value = this.values.get(state);
    if (!value || value.userId !== userId || value.expiresAt <= now) return false;
    this.values.delete(state);
    return true;
  }
}

function normalizeSearchInput(input: {
  query: string;
  pageToken?: string | undefined;
}): GoogleRequestOptions {
  return { query: input.query, ...(input.pageToken ? { pageToken: input.pageToken } : {}) };
}

export function createOAuthState(userId: string): { state: string; hash: string } {
  const state = `${userId}.${generateId()}`;
  return { state, hash: createHash('sha256').update(state).digest('hex') };
}

export interface GmailPubSubNotification {
  emailAddress: string;
  historyId: string;
}

export class GooglePubSubVerifier {
  constructor(
    private readonly audience: string | undefined,
    private readonly verifyBearer: (token: string, audience: string) => Promise<boolean>,
  ) {}

  async verify(headers: { authorization?: string }): Promise<boolean> {
    if (!this.audience || !headers.authorization?.startsWith('Bearer ')) return false;
    return this.verifyBearer(headers.authorization.slice('Bearer '.length), this.audience);
  }
}

export function parseGmailPubSubBody(body: unknown): GmailPubSubNotification {
  const parsed = z.object({ message: z.object({ data: z.string().min(1) }) }).parse(body);
  const decoded = Buffer.from(parsed.message.data, 'base64url').toString('utf8');
  return z
    .object({ emailAddress: z.string().email(), historyId: z.string().min(1) })
    .parse(JSON.parse(decoded));
}

function escapeDriveQuery(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

async function readHistoryWithFetch(
  fetchImpl: typeof fetch,
  historyId: string,
): Promise<{
  history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
  historyId: string;
}> {
  const response = await fetchImpl(
    `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(historyId)}&historyTypes=messageAdded`,
    { headers: { authorization: 'connector-test-token' } },
  );
  if (response.status === 404) throw new GmailHistoryCursorExpiredError();
  if (!response.ok) throw new Error(`GMAIL_HISTORY_${response.status}`);
  return response.json() as Promise<{
    history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
    historyId: string;
  }>;
}
