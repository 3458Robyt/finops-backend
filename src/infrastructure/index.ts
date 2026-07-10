/**
 * ═══════════════════════════════════════════════════════════════
 * Infrastructure Layer — Barrel Export
 * ═══════════════════════════════════════════════════════════════
 *
 * Punto de entrada único (*barrel*) de la capa de infraestructura. Reexporta
 * los adaptadores concretos que implementan las interfaces del dominio, para
 * que las capas superiores (aplicación, composición de dependencias) los
 * importen desde un único módulo sin acoplarse a las rutas internas.
 *
 * Agrupa:
 * - Proveedores cloud: {@link AWSProvider}, {@link OCIProvider}.
 * - Gateway de IA: {@link OpenAiCompatibleAiGateway}.
 * - Acceso a base de datos: {@link getPrismaClient}.
 * - Repositorios Prisma (costes, conexiones cloud, recomendaciones, usuarios, etc.).
 * - Seguridad: {@link Argon2PasswordHasher}, {@link CredentialCipher}, {@link JwtTokenService}.
 */
export { AWSProvider } from './providers/aws/index.js';
export { OpenAiCompatibleAiGateway } from './ai/OpenAiCompatibleAiGateway.js';
export { getPrismaClient } from './database/prisma.js';
export { AwsSdkIngestionProvider } from './ingestion/AwsSdkIngestionProvider.js';
export { OciSdkIngestionProvider } from './ingestion/OciSdkIngestionProvider.js';
export { PrismaCloudIngestionJobRepository } from './ingestion/PrismaCloudIngestionJobRepository.js';
export { OCIProvider } from './providers/oci/index.js';
export { PrismaCostAnalyticsRepository } from './repositories/PrismaCostAnalyticsRepository.js';
export { PrismaAgentLearningRepository } from './repositories/PrismaAgentLearningRepository.js';
export { PrismaCloudConnectionRepository } from './repositories/PrismaCloudConnectionRepository.js';
export { PrismaCostRepository } from './repositories/PrismaCostRepository.js';
export { PrismaRecommendationRepository } from './repositories/PrismaRecommendationRepository.js';
export { PrismaUserRepository } from './repositories/PrismaUserRepository.js';
export { Argon2PasswordHasher } from './security/Argon2PasswordHasher.js';
export { CredentialCipher, type EncryptedCredentialPayload } from './security/CredentialCipher.js';
export { JwtTokenService } from './security/JwtTokenService.js';
