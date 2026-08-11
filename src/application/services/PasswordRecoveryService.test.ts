import { describe, expect, test } from 'vitest';
import { PasswordRecoveryService } from './PasswordRecoveryService.js';
import type {
  ConsumePasswordResetInput,
  CreatePasswordResetTokenInput,
  IAccountRecoveryRepository,
  PasswordResetTarget,
  PasswordResetTokenRecord,
} from '../../domain/interfaces/IAccountRecoveryRepository.js';
import type { IAuthSessionRepository } from '../../domain/interfaces/IAuthSessionRepository.js';
import type { AuthSessionSummary } from '../../domain/interfaces/IAuthSessionRepository.js';
import type { IPasswordHasher } from '../../domain/interfaces/IPasswordHasher.js';
import type { EmailSendInput, IEmailClient } from './EmailClient.js';

class FakeRecoveryRepository implements IAccountRecoveryRepository {
  public token: PasswordResetTokenRecord | null = null;
  public created: CreatePasswordResetTokenInput | null = null;
  public target: PasswordResetTarget = { userId: 'user-1', email: 'user@example.com', name: 'User', status: 'ACTIVE' };
  public async findUserByEmail(): Promise<PasswordResetTarget | null> { return this.target; }
  public async createPasswordResetToken(input: CreatePasswordResetTokenInput): Promise<void> {
    this.created = input;
    this.token = { userId: input.userId, tokenHash: input.tokenHash, expiresAt: input.expiresAt };
  }
  public async findPasswordResetToken(): Promise<PasswordResetTokenRecord | null> { return this.token; }
  public async consumeAndUpdatePassword(input: ConsumePasswordResetInput): Promise<PasswordResetTarget | null> {
    if (this.token === null || this.token.tokenHash !== input.tokenHash || this.token.usedAt !== undefined) return null;
    this.token = { ...this.token, usedAt: new Date() };
    return this.target;
  }
}

class FakeSessions implements IAuthSessionRepository {
  public revokedUserId: string | null = null;
  public async isActive(): Promise<boolean> { return true; }
  public async revokeCurrent(): Promise<boolean> { return true; }
  public async revokeAll(userId: string): Promise<number> { this.revokedUserId = userId; return 1; }
  public async listActive(): Promise<readonly AuthSessionSummary[]> { return []; }
  public async revokeById(): Promise<boolean> { return true; }
}

class FakeHasher implements IPasswordHasher {
  public async hash(value: string): Promise<string> { return `hash:${value}`; }
  public async verify(): Promise<boolean> { return true; }
}

class FakeEmail implements IEmailClient {
  public enabled = true;
  public sent = 0;
  public lastText = '';
  public async send(input: EmailSendInput): Promise<{ readonly messageId?: string }> { this.sent += 1; this.lastText = input.text; return {}; }
}

describe('PasswordRecoveryService', () => {
  test('creates a one-use reset token and revokes sessions after confirmation', async () => {
    const repository = new FakeRecoveryRepository();
    const sessions = new FakeSessions();
    const email = new FakeEmail();
    const service = new PasswordRecoveryService(repository, new FakeHasher(), sessions, email);

    await expect(service.requestReset({ email: 'USER@EXAMPLE.COM' })).resolves.toEqual({ accepted: true, emailSent: true });
    expect(repository.created?.tokenHash).toBeDefined();
    const rawToken = new URL(new RegExp('https?[^\\s]+').exec(email.lastText)![0]).searchParams.get('token')!;
    await service.confirmReset({ token: rawToken, password: 'StrongPassword1' });
    expect(sessions.revokedUserId).toBe('user-1');
    await expect(service.confirmReset({ token: rawToken, password: 'StrongPassword1' })).rejects.toThrow();
    expect(email.sent).toBe(1);
  });

  test('does not reveal whether an unknown email exists', async () => {
    const repository = new FakeRecoveryRepository();
    repository.target = { ...repository.target, status: 'DISABLED' };
    const service = new PasswordRecoveryService(repository, new FakeHasher(), new FakeSessions(), new FakeEmail());
    await expect(service.requestReset({ email: 'unknown@example.com' })).resolves.toEqual({ accepted: true, emailSent: false });
  });
});
