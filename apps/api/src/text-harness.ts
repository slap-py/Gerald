import { generateId } from '@gerald/security';
import { createDevelopmentRuntime } from '@gerald/runtime';
import type { Identity } from '@gerald/contracts';

const identity: Identity = {
  userId: '00000000-0000-4000-8000-000000000001',
  preferredName: 'Owner',
  assistantName: 'Gerald',
  timezone: 'America/Los_Angeles',
  authorizedEmails: ['owner@example.com'],
  authorizedPhoneNumbers: [],
  outboundEmailWhitelist: ['owner@example.com'],
  outboundPhoneWhitelist: [],
  securityMode: 'NORMAL',
};
const { runtime, state } = createDevelopmentRuntime(identity);
const sessionId = generateId();
const requestText = process.argv.slice(2).join(' ') || 'remember that I prefer concise updates';
const result = await runtime.run({
  version: '1.0',
  triggerEventId: `harness:${generateId()}`,
  userId: identity.userId,
  sessionId,
  channel: 'text',
  authentication: 'authenticated',
  requestedOperation: 'development text harness request',
  envelope: {
    version: '1.0',
    providerEventId: `harness:${generateId()}`,
    channel: 'text',
    senderIdentity: identity.userId,
    authorizedSender: true,
    userAuthoredText: requestText,
    untrustedContent: [],
    attachments: [],
    timestamp: new Date(),
    replyRoute: { channel: 'text', destination: identity.userId },
    rawProviderType: 'development.text',
  },
});
console.log(
  JSON.stringify({ result, audit: state.audit.list(), outbox: state.outbox.pending() }, null, 2),
);
