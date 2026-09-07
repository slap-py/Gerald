import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ChannelEnvelope, UntrustedContent } from '@gerald/contracts';
import { ChannelEnvelopeSchema } from '@gerald/contracts';
import { generateId, hashForDeduplication } from '@gerald/security';

const HeaderSchema = z.union([
  z.record(z.string()),
  z.array(z.object({ name: z.string(), value: z.string() })),
]);
const InboundPayloadSchema = z.object({
  type: z.string().optional(),
  data: z.object({
    email_id: z.string().optional(),
    id: z.string().optional(),
    from: z.string(),
    to: z.union([z.string(), z.array(z.string())]),
    subject: z.string().optional(),
    text: z.string().optional(),
    html: z.string().optional(),
    headers: HeaderSchema.optional(),
    attachments: z
      .array(
        z.object({
          id: z.string().optional(),
          filename: z.string(),
          content_type: z.string().optional(),
          size: z.number().int().nonnegative().optional(),
          content: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

export interface ResendSignatureHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

export class ResendWebhookVerifier {
  constructor(
    private readonly secret: string,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  verify(rawBody: string, headers: ResendSignatureHeaders): boolean {
    if (!this.secret || !headers.id || !headers.timestamp || !headers.signature) return false;
    const timestampMs = Number(headers.timestamp) * 1000;
    if (!Number.isFinite(timestampMs) || Math.abs(this.clock() - timestampMs) > 5 * 60 * 1000)
      return false;
    const secretBytes = Buffer.from(this.secret.replace(/^whsec_/, ''), 'base64');
    const expected = createHmac('sha256', secretBytes)
      .update(`${headers.id}.${headers.timestamp}.${rawBody}`)
      .digest('base64');
    const accepted = headers.signature
      .split(' ')
      .map((item) => item.replace(/^v\d+,/, ''))
      .filter(Boolean);
    return accepted.some((candidate) => {
      const left = Buffer.from(candidate);
      const right = Buffer.from(expected);
      return left.length === right.length && timingSafeEqual(left, right);
    });
  }
}

export interface NormalizedEmail {
  envelope: ChannelEnvelope;
  subject: string;
  headers: Record<string, string>;
}

export function normalizeInboundEmail(
  raw: unknown,
  authorizedEmails: readonly string[],
  assistantEmail: string,
): NormalizedEmail {
  const event = InboundPayloadSchema.parse(raw);
  const data = event.data;
  const providerEventId = data.email_id ?? data.id ?? generateId();
  const senderIdentity = extractAddress(data.from).toLowerCase();
  const authorizedSender = authorizedEmails
    .map((email) => email.toLowerCase())
    .includes(senderIdentity);
  const headers = normalizeHeaders(data.headers);
  const body = data.text ?? stripHtml(data.html ?? '');
  const split = splitTrustedEmailContent(body, authorizedSender);
  const to = Array.isArray(data.to) ? (data.to[0] ?? assistantEmail) : data.to;
  const attachments = new AttachmentPipeline().inspect(
    (data.attachments ?? []).map((attachment) => ({
      ...(attachment.id ? { providerId: attachment.id } : {}),
      filename: attachment.filename,
      mimeType: attachment.content_type ?? 'application/octet-stream',
      byteSize:
        attachment.size ??
        (attachment.content ? Buffer.byteLength(attachment.content, 'base64') : 0),
    })),
  );
  const envelope: ChannelEnvelope = ChannelEnvelopeSchema.parse({
    version: '1.0',
    providerEventId,
    channel: 'email',
    senderIdentity,
    authorizedSender,
    userAuthoredText: split.trustedText,
    untrustedContent: split.untrustedContent,
    attachments,
    ...(headers['thread-id'] ? { threadId: headers['thread-id'] } : {}),
    timestamp: new Date(),
    replyRoute: {
      channel: 'email',
      destination: senderIdentity,
      ...(headers['message-id'] ? { inReplyTo: headers['message-id'] } : {}),
      ...(headers['thread-id'] ? { threadId: headers['thread-id'] } : {}),
    },
    rawProviderType: event.type ?? 'email.received',
  });
  return { envelope, subject: data.subject ?? '', headers };
}

export function splitTrustedEmailContent(
  body: string,
  authorizedSender: boolean,
): { trustedText: string; untrustedContent: UntrustedContent[] } {
  if (!authorizedSender)
    return {
      trustedText: '',
      untrustedContent: body
        ? [{ text: body, source: 'unknown_sender', trustedAsInstruction: false }]
        : [],
    };
  const trusted: string[] = [];
  const untrusted: string[] = [];
  let inQuote = false;
  for (const line of body.split(/\r?\n/)) {
    const isQuote =
      /^\s*>/.test(line) ||
      /^-{2,}\s*(forwarded message|original message)\s*-{2,}/i.test(line) ||
      /^on .+ wrote:\s*$/i.test(line);
    if (isQuote) inQuote = true;
    if (inQuote) untrusted.push(line);
    else trusted.push(line);
  }
  return {
    trustedText: trusted.join('\n').trim(),
    untrustedContent: untrusted.length
      ? [{ text: untrusted.join('\n').trim(), source: 'quote', trustedAsInstruction: false }]
      : [],
  };
}

export class AttachmentPipeline {
  constructor(
    private readonly options: { maxBytes?: number; allowedMimeTypes?: readonly string[] } = {},
  ) {}

  inspect(
    attachments: readonly {
      providerId?: string;
      filename: string;
      mimeType: string;
      byteSize: number;
    }[],
  ): ChannelEnvelope['attachments'] {
    const maxBytes = this.options.maxBytes ?? 10 * 1024 * 1024;
    const allowed = this.options.allowedMimeTypes ?? [
      'text/plain',
      'text/csv',
      'application/pdf',
      'application/json',
      'image/png',
      'image/jpeg',
    ];
    return attachments.map((attachment) => ({
      id: generateId(),
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
      sha256: hashForDeduplication(
        `${attachment.filename}:${attachment.byteSize}:${attachment.providerId ?? ''}`,
      ),
      status:
        attachment.byteSize > maxBytes ||
        !allowed.includes(attachment.mimeType) ||
        isDangerousFilename(attachment.filename)
          ? ('quarantined' as const)
          : ('pending' as const),
    }));
  }

  acceptAfterMalwareScan(
    attachment: ChannelEnvelope['attachments'][number],
    malwareClean: boolean,
    extractedText?: string,
  ): ChannelEnvelope['attachments'][number] {
    if (!malwareClean) return { ...attachment, status: 'quarantined' };
    return {
      ...attachment,
      status: 'accepted',
      ...(extractedText ? { extractedText: extractedText.slice(0, 100_000) } : {}),
    };
  }
}

export class ResendApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class ResendClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendReply(input: {
    from: string;
    to: string;
    subject: string;
    text: string;
    inReplyTo?: string;
    references?: string;
  }): Promise<{ id: string }> {
    const headers: Record<string, string> = {};
    if (input.inReplyTo) headers['In-Reply-To'] = input.inReplyTo;
    if (input.references) headers.References = input.references;
    const response = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject.startsWith('Re:') ? input.subject : `Re: ${input.subject}`,
        text: input.text,
        headers,
      }),
    });
    if (!response.ok)
      throw new ResendApiError(response.status, `Resend email send failed: ${response.status}`);
    return response.json() as Promise<{ id: string }>;
  }

  async retrieveAttachment(emailId: string, attachmentId: string): Promise<Uint8Array> {
    const response = await this.fetchImpl(
      `https://api.resend.com/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { headers: { authorization: `Bearer ${this.apiKey}` } },
    );
    if (!response.ok)
      throw new ResendApiError(
        response.status,
        `Resend attachment retrieval failed: ${response.status}`,
      );
    return new Uint8Array(await response.arrayBuffer());
  }
}

export interface WebhookReceiptStore {
  has(provider: string, eventId: string): Promise<boolean>;
  accept(provider: string, eventId: string, payloadHash: string): Promise<void>;
}
export class InMemoryWebhookReceiptStore implements WebhookReceiptStore {
  private readonly receipts = new Map<string, string>();
  async has(provider: string, eventId: string): Promise<boolean> {
    return this.receipts.has(`${provider}:${eventId}`);
  }
  async accept(provider: string, eventId: string, payloadHash: string): Promise<void> {
    this.receipts.set(`${provider}:${eventId}`, payloadHash);
  }
}

export class EmailWebhookProcessor {
  constructor(
    private readonly verifier: ResendWebhookVerifier,
    private readonly receipts: WebhookReceiptStore,
    private readonly authorizedEmails: readonly string[],
    private readonly assistantEmail: string,
  ) {}

  async process(
    rawBody: string,
    signature: ResendSignatureHeaders,
  ): Promise<{ accepted: boolean; duplicate: boolean; email?: NormalizedEmail }> {
    if (!this.verifier.verify(rawBody, signature)) throw new Error('RESEND_INVALID_SIGNATURE');
    const parsed = JSON.parse(rawBody) as unknown;
    const event = InboundPayloadSchema.parse(parsed);
    const eventId = event.data.email_id ?? event.data.id ?? signature.id;
    if (await this.receipts.has('resend', eventId)) return { accepted: true, duplicate: true };
    const email = normalizeInboundEmail(parsed, this.authorizedEmails, this.assistantEmail);
    await this.receipts.accept('resend', eventId, hashForDeduplication(rawBody));
    return { accepted: true, duplicate: false, email };
  }
}

export interface DeliveryEvent {
  id: string;
  emailId?: string;
  status: 'delivered' | 'bounced' | 'failed' | 'complained' | 'opened' | 'clicked';
  recipient?: string;
  occurredAt: Date;
}
export class ResendDeliveryProcessor {
  constructor(
    private readonly verifier: ResendWebhookVerifier,
    private readonly receipts: WebhookReceiptStore,
  ) {}

  async process(
    rawBody: string,
    signature: ResendSignatureHeaders,
  ): Promise<{ accepted: boolean; duplicate: boolean; event?: DeliveryEvent }> {
    if (!this.verifier.verify(rawBody, signature)) throw new Error('RESEND_INVALID_SIGNATURE');
    const parsed = z
      .object({
        type: z.string(),
        data: z.object({
          email_id: z.string().optional(),
          id: z.string().optional(),
          status: z.enum(['delivered', 'bounced', 'failed', 'complained', 'opened', 'clicked']),
          to: z.union([z.string(), z.array(z.string())]).optional(),
          created_at: z.string().optional(),
        }),
      })
      .parse(JSON.parse(rawBody));
    const eventId = parsed.data.id ?? signature.id;
    if (await this.receipts.has('resend.delivery', eventId))
      return { accepted: true, duplicate: true };
    await this.receipts.accept('resend.delivery', eventId, hashForDeduplication(rawBody));
    return {
      accepted: true,
      duplicate: false,
      event: {
        id: eventId,
        ...(parsed.data.email_id ? { emailId: parsed.data.email_id } : {}),
        status: parsed.data.status,
        ...(parsed.data.to
          ? { recipient: Array.isArray(parsed.data.to) ? parsed.data.to[0] : parsed.data.to }
          : {}),
        occurredAt: parsed.data.created_at ? new Date(parsed.data.created_at) : new Date(),
      },
    };
  }
}

export function canReplyToEmail(recipient: string, whitelist: readonly string[]): boolean {
  return whitelist.map((value) => value.toLowerCase()).includes(recipient.trim().toLowerCase());
}

function normalizeHeaders(input: z.infer<typeof HeaderSchema> | undefined): Record<string, string> {
  if (!input) return {};
  if (Array.isArray(input))
    return Object.fromEntries(input.map((item) => [item.name.toLowerCase(), item.value]));
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key.toLowerCase(), value]),
  );
}
function extractAddress(value: string): string {
  return value.match(/<([^>]+)>/)?.[1] ?? value.trim();
}
function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function isDangerousFilename(filename: string): boolean {
  return /\.(exe|dll|bat|cmd|com|js|vbs|ps1|scr|jar|msi|zip)$/i.test(filename);
}
