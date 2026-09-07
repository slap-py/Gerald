import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import argon2 from 'argon2';

export interface EncryptedSecret {
  version: 1;
  algorithm: 'AES-256-GCM';
  iv: string;
  tag: string;
  ciphertext: string;
}

function keyFromBase64(masterKeyBase64: string): Buffer {
  const key = Buffer.from(masterKeyBase64, 'base64');
  if (key.length !== 32) throw new Error('Master key must decode to exactly 32 bytes');
  return key;
}

export class SecretCipher {
  private readonly key: Buffer;

  constructor(masterKeyBase64: string) {
    this.key = keyFromBase64(masterKeyBase64);
  }

  encrypt(plaintext: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      version: 1,
      algorithm: 'AES-256-GCM',
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
  }

  decrypt(secret: EncryptedSecret): string {
    if (secret.version !== 1 || secret.algorithm !== 'AES-256-GCM')
      throw new Error('Unsupported secret envelope');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(secret.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

export async function hashVerifier(value: string): Promise<string> {
  return argon2.hash(value, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyVerifier(hash: string, value: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, value);
  } catch {
    return false;
  }
}

export function hashForDeduplication(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function generateRecoveryCode(): string {
  return randomBytes(10).toString('hex').toUpperCase();
}

export function generateId(): string {
  return randomUUID();
}

export class PinAttemptGuard {
  private readonly failures = new Map<string, { count: number; lockedUntil?: number }>();
  private readonly callAttempts = new Map<string, number>();

  beginCall(callId: string): void {
    this.callAttempts.set(callId, 0);
  }

  canAttempt(identityKey: string, callId: string, now = Date.now()): boolean {
    const identity = this.failures.get(identityKey);
    if (identity?.lockedUntil && identity.lockedUntil > now) return false;
    return (this.callAttempts.get(callId) ?? 0) < 3;
  }

  recordFailure(identityKey: string, callId: string, now = Date.now()): void {
    this.callAttempts.set(callId, (this.callAttempts.get(callId) ?? 0) + 1);
    const next = this.failures.get(identityKey) ?? { count: 0 };
    next.count += 1;
    if (next.count >= 5) next.lockedUntil = now + 15 * 60 * 1000;
    this.failures.set(identityKey, next);
  }

  recordSuccess(identityKey: string, callId: string): void {
    this.failures.delete(identityKey);
    this.callAttempts.delete(callId);
  }
}

export class PasskeyChallengeService {
  private readonly challenges = new Map<
    string,
    { userId: string; challenge: string; expiresAt: number; consumed: boolean }
  >();

  start(
    userId: string,
    now = Date.now(),
  ): { challengeId: string; challenge: string; expiresAt: Date } {
    const challengeId = randomUUID();
    const challenge = randomBytes(32).toString('base64url');
    const expiresAt = now + 5 * 60 * 1000;
    this.challenges.set(challengeId, { userId, challenge, expiresAt, consumed: false });
    return { challengeId, challenge, expiresAt: new Date(expiresAt) };
  }

  consume(
    challengeId: string,
    userId: string,
    assertion: unknown,
    verify: (challenge: string, assertion: unknown) => boolean,
    now = Date.now(),
  ): boolean {
    const record = this.challenges.get(challengeId);
    if (
      !record ||
      record.userId !== userId ||
      record.consumed ||
      record.expiresAt <= now ||
      !verify(record.challenge, assertion)
    )
      return false;
    record.consumed = true;
    return true;
  }
}

export class RecoveryCodeService {
  private readonly verifiers = new Map<string, Set<string>>();

  async issue(userId: string, count = 10): Promise<string[]> {
    const plaintext: string[] = [];
    const hashes = new Set<string>();
    for (let index = 0; index < count; index += 1) {
      const code = generateRecoveryCode();
      plaintext.push(code);
      hashes.add(await hashVerifier(code));
    }
    this.verifiers.set(userId, hashes);
    return plaintext;
  }

  async consume(userId: string, code: string): Promise<boolean> {
    const hashes = this.verifiers.get(userId);
    if (!hashes) return false;
    for (const hash of hashes) {
      if (await verifyVerifier(hash, code)) {
        hashes.delete(hash);
        return true;
      }
    }
    return false;
  }
}
