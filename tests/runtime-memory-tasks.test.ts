import { describe, expect, it } from 'vitest';
import type { Identity } from '@gerald/contracts';
import { createDevelopmentRuntime } from '@gerald/runtime';
import { InMemoryMemoryStore, assembleContext } from '@gerald/memory';
import { TaskService } from '@gerald/tasks';

const user: Identity = {
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

describe('runtime, memory, and tasks', () => {
  it('runs a text request, persists a memory, and creates an audit/outbox trail', async () => {
    const { runtime, state } = createDevelopmentRuntime(user);
    const result = await runtime.run({
      version: '1.0',
      triggerEventId: 'trigger-1',
      userId: user.userId,
      sessionId: '00000000-0000-4000-8000-000000000002',
      channel: 'text',
      authentication: 'authenticated',
      requestedOperation: 'remember preference',
      envelope: {
        version: '1.0',
        providerEventId: 'event-1',
        channel: 'text',
        senderIdentity: user.userId,
        authorizedSender: true,
        userAuthoredText: 'remember that I like concise updates',
        untrustedContent: [],
        attachments: [],
        timestamp: new Date(),
        replyRoute: { channel: 'text', destination: user.userId },
        rawProviderType: 'test',
      },
    });
    expect(result.toolResults[0]?.status).toBe('confirmed_success');
    expect(state.memory.all(user.userId)).toHaveLength(1);
    expect(state.audit.list().map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        'agent.run.started',
        'policy.decision',
        'tool.execution',
        'agent.run.completed',
      ]),
    );
    expect(state.outbox.pending()[0]?.topic).toBe('memory.extract');
  });

  it('filters secret-like memory and bounds assembled context', () => {
    const memory = new InMemoryMemoryStore();
    expect(
      memory.propose(user.userId, {
        kind: 'fact',
        text: 'my API key is sk-1234567890123456',
        provenance: { sourceId: 'x', sourceType: 'test' },
        confidence: 1,
        sensitivity: 'normal',
      }),
    ).toBeNull();
    const context = assembleContext({
      identity: user,
      channel: 'text',
      authentication: 'authenticated',
      instructions: ['i'],
      profile: ['p'],
      session: Array.from({ length: 30 }, () => 'turn '.repeat(1000)),
      task: ['task'],
      retrieval: { memories: [], sources: [] },
      liveToolResults: [],
      maxTokens: 100,
    });
    expect(context.activeSession.length).toBeLessThanOrEqual(4);
    expect(context.estimatedTokens).toBeGreaterThan(0);
  });

  it('requires trigger events and caps task depth', () => {
    const tasks = new TaskService();
    const first = tasks.create(user.userId, 'one');
    const second = tasks.create(user.userId, 'two', { parentTaskId: first.id });
    const third = tasks.create(user.userId, 'three', { parentTaskId: second.id });
    expect(() => tasks.create(user.userId, 'four', { parentTaskId: third.id })).toThrow(
      'three levels',
    );
    expect(() => tasks.transition(first.id, 'COMPLETED', '')).toThrow('trigger');
  });
});
