import { describe, expect, it } from 'vitest';
import { createApi } from '../apps/api/src/app.js';
import type { AppConfig } from '@gerald/config';

const config: AppConfig = {
  env: 'test',
  port: 0,
  models: { text: 'test', realtime: 'test', embedding: 'test' },
  resend: { fromEmail: 'Gerald <gerald@example.com>', assistantEmail: 'gerald@example.com' },
  authorizedEmails: ['owner@example.com'],
  google: { redirectUri: 'http://localhost/callback' },
  consoleOrigin: 'http://localhost:3001',
  timezone: 'America/Los_Angeles',
  systemMode: 'NORMAL',
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

describe('API ingress', () => {
  it('uses the same runtime for the development text harness', async () => {
    const app = await createApi({ config });
    const response = await app.inject({
      method: 'POST',
      url: '/api/harness/text',
      payload: { text: 'remember that I like tests' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().toolResults[0].status).toBe('confirmed_success');
    await app.close();
  });

  it('keeps console mutation routes behind the console auth boundary', async () => {
    const app = await createApi({ config });
    const denied = await app.inject({
      method: 'POST',
      url: '/api/security/mode',
      payload: { mode: 'LOCKED' },
    });
    expect(denied.statusCode).toBe(401);
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/security/mode',
      headers: { 'x-gerald-dev-auth': 'true' },
      payload: { mode: 'LOCKED' },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });
});
