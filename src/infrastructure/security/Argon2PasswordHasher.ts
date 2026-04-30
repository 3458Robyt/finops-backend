import argon2 from 'argon2';
import type { IPasswordHasher } from '../../domain/interfaces/IPasswordHasher.js';

export class Argon2PasswordHasher implements IPasswordHasher {
  public async hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  }

  public async verify(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password);
  }
}
