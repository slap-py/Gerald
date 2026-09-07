import type { NotificationJob } from '@gerald/contracts';
import { TransactionalOutbox } from '@gerald/runtime';

export interface NotificationDelivery {
  send(input: {
    recipient: string;
    subject: string;
    text: string;
  }): Promise<{ providerId: string }>;
}

export class NotificationScheduler {
  constructor(private readonly timezone = 'America/Los_Angeles') {}

  isQuietHour(at: Date): boolean {
    const hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: this.timezone,
        hour: '2-digit',
        hour12: false,
      }).format(at),
    );
    return hour >= 21 || hour < 7;
  }

  shouldDeliver(job: NotificationJob, now = new Date()): boolean {
    if (job.state !== 'PENDING' || job.triggerAt > now) return false;
    return !(job.quietHourPolicy === 'defer_non_urgent' && this.isQuietHour(now));
  }
}

export class DeterministicNotificationWorker {
  private readonly completed = new Set<string>();
  constructor(
    private readonly scheduler: NotificationScheduler,
    private readonly delivery: NotificationDelivery,
    private readonly outbox: TransactionalOutbox,
  ) {}

  async process(job: NotificationJob, now = new Date()): Promise<'skipped' | 'completed'> {
    if (this.completed.has(job.deduplicationKey) || !this.scheduler.shouldDeliver(job, now))
      return 'skipped';
    const data = job.minimalFormattingData;
    const subject = data.subject ?? (job.kind === 'reminder' ? 'Reminder' : 'New watched email');
    const text = data.text ?? `${job.kind} is ready.`;
    const receipt = await this.delivery.send({ recipient: job.recipient, subject, text });
    this.completed.add(job.deduplicationKey);
    this.outbox.enqueue('notification.delivered', job.deduplicationKey, {
      providerId: receipt.providerId,
      kind: job.kind,
    });
    return 'completed';
  }
}
