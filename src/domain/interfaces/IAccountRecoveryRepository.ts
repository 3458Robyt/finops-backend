export interface PasswordResetTarget {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'DISABLED';
}

export interface PasswordResetTokenRecord {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly usedAt?: Date;
}

export interface CreatePasswordResetTokenInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly ipAddress?: string;
}

export interface ConsumePasswordResetInput {
  readonly tokenHash: string;
  readonly passwordHash: string;
}

export interface IAccountRecoveryRepository {
  findUserByEmail(email: string): Promise<PasswordResetTarget | null>;
  createPasswordResetToken(input: CreatePasswordResetTokenInput): Promise<void>;
  findPasswordResetToken(tokenHash: string): Promise<PasswordResetTokenRecord | null>;
  consumeAndUpdatePassword(input: ConsumePasswordResetInput): Promise<PasswordResetTarget | null>;
}
