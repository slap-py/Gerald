import { describe, expect, it } from 'vitest';
import { evaluatePolicy } from '@gerald/policy';
import { SecretCipher, PinAttemptGuard, PasskeyChallengeService } from '@gerald/security';
import type { Identity, ToolDescriptor } from '@gerald/contracts';
import { z } from 'zod';

const identity = (mode: Identity['securityMode'] = 'NORMAL'): Identity => ({
  userId: '00000000-0000-4000-8000-000000000001',
  preferredName: 'Owner',
  assistantName: 'Gerald',
  timezone: 'America/Los_Angeles',
  authorizedEmails: ['owner@example.com'],
  authorizedPhoneNumbers: [],
  outboundEmailWhitelist: ['owner@example.com'],
  outboundPhoneWhitelist: [],
  securityMode: mode,
});
const tool = (name: string, overrides: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  name,
  version: '1.0',
  description: 'test',
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  riskLevel: 'low',
  sensitivity: 'private',
  requiredAuthentication: 'authenticated',
  allowedModes: ['NORMAL', 'READ_ONLY'],
  allowedChannels: ['text', 'email'],
  idempotency: 'read',
  auditRedaction: [],
  ...overrides,
});

describe('security and policy invariants', () => {
  it('encrypts and decrypts secrets without storing plaintext', () => {
    const cipher = new SecretCipher(Buffer.alloc(32, 7).toString('base64'));
    const encrypted = cipher.encrypt('oauth-refresh-token');
    expect(JSON.stringify(encrypted)).not.toContain('oauth-refresh-token');
    expect(cipher.decrypt(encrypted)).toBe('oauth-refresh-token');
  });

  it('denies locked private tools and non-whitelisted email destinations', () => {
    expect(
      evaluatePolicy({
        tool: tool('google.gmail.search_threads'),
        channel: 'text',
        authentication: 'authenticated',
        identity: identity('LOCKED'),
      }).effect,
    ).toBe('deny');
    expect(
      evaluatePolicy({
        tool: tool('email.send', { idempotency: 'write' }),
        channel: 'email',
        authentication: 'authenticated',
        identity: identity(),
        target: 'other@example.com',
      }).effect,
    ).toBe('deny');
  });

  it('enforces three attempts per call and locks after five identity failures', () => {
    const guard = new PinAttemptGuard();
    guard.beginCall('call-1');
    expect(guard.canAttempt('phone:+15550001', 'call-1')).toBe(true);
    guard.recordFailure('phone:+15550001', 'call-1');
    guard.recordFailure('phone:+15550001', 'call-1');
    guard.recordFailure('phone:+15550001', 'call-1');
    expect(guard.canAttempt('phone:+15550001', 'call-1')).toBe(false);
    guard.beginCall('call-2');
    guard.recordFailure('phone:+15550001', 'call-2');
    guard.recordFailure('phone:+15550001', 'call-2');
    expect(guard.canAttempt('phone:+15550001', 'call-2')).toBe(false);
  });

  it('consumes a passkey challenge once', () => {
    const service = new PasskeyChallengeService();
    const started = service.start('user-1', 1000);
    const verify = (challenge: string, assertion: unknown) =>
      challenge === (assertion as { challenge: string }).challenge;
    expect(
      service.consume(
        started.challengeId,
        'user-1',
        { challenge: started.challenge },
        verify,
        1001,
      ),
    ).toBe(true);
    expect(
      service.consume(
        started.challengeId,
        'user-1',
        { challenge: started.challenge },
        verify,
        1001,
      ),
    ).toBe(false);
  });
});
