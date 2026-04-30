import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { ConfigurationError } from '../../domain/errors/errors.js';

let prismaClient: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  if (prismaClient !== undefined) {
    return prismaClient;
  }

  const connectionString = process.env['DATABASE_URL'];

  if (connectionString === undefined || connectionString.trim() === '') {
    throw new ConfigurationError('DATABASE_URL must be configured before using Prisma');
  }

  const adapter = new PrismaPg({ connectionString });
  prismaClient = new PrismaClient({ adapter });

  return prismaClient;
}
