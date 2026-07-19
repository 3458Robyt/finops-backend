import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { ConfigurationError } from '../../domain/errors/errors.js';

/** Instancia singleton del cliente Prisma, reutilizada entre llamadas. */
let prismaClient: PrismaClient | undefined;

/**
 * Devuelve la instancia singleton del {@link PrismaClient}, creándola de forma
 * perezosa (*lazy*) en la primera invocación.
 *
 * Actúa como factoría/adaptador de infraestructura para el acceso a la base de
 * datos PostgreSQL: usa el adaptador `@prisma/adapter-pg` (`PrismaPg`) con la
 * cadena de conexión definida en la variable de entorno `DATABASE_URL`.
 * Reutilizar una única instancia evita agotar el pool de conexiones.
 *
 * @returns El cliente Prisma compartido para toda la aplicación.
 * @throws {ConfigurationError} Si `DATABASE_URL` no está configurada o está vacía.
 */
export function getPrismaClient(): PrismaClient {
  if (prismaClient !== undefined) {
    return prismaClient;
  }

  const connectionString = process.env['DATABASE_URL'];

  if (connectionString === undefined || connectionString.trim() === '') {
    throw new ConfigurationError('DATABASE_URL must be configured before using Prisma');
  }

  const schema = new URL(connectionString).searchParams.get('schema') ?? undefined;
  if (schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new ConfigurationError('DATABASE_URL schema must be a valid PostgreSQL identifier');
  }
  const adapter = new PrismaPg(
    {
      connectionString,
      ...(schema === undefined ? {} : { options: `-c search_path=${schema}` }),
    },
    schema === undefined ? undefined : { schema },
  );
  prismaClient = new PrismaClient({ adapter });

  return prismaClient;
}
