/**
 * ═══════════════════════════════════════════════════════════════
 * FinOps Inteligente — Entry Point (Composition Root)
 * ═══════════════════════════════════════════════════════════════
 *
 * Punto de entrada principal de la aplicación.
 * Aquí se realiza la Composición Raíz (Composition Root):
 *   1. Instanciar adaptadores de proveedores de nube.
 *   2. Registrarlos en el mapa de proveedores (DI manual).
 *   3. Instanciar el servicio de ingesta.
 *   4. Ejecutar una ingesta de demostración.
 *
 * En producción, este archivo se reemplazaría por un servidor
 * HTTP (Express/Fastify) que expone la API REST y utiliza un
 * contenedor de DI más robusto (tsyringe, inversify, etc.).
 *
 * @module index
 */

import 'dotenv/config';

import type { ICloudProvider } from './domain/interfaces/ICloudProvider.js';
import { AuthService } from './application/services/AuthService.js';
import { AgentInstructionService } from './application/services/AgentInstructionService.js';
import { AgentLearningService } from './application/services/AgentLearningService.js';
import { AiObservabilityService } from './application/services/AiObservabilityService.js';
import { CloudConnectionService } from './application/services/CloudConnectionService.js';
import { ContextEngineService } from './application/services/ContextEngineService.js';
import { ContextSummaryBuilderService } from './application/services/ContextSummaryBuilderService.js';
import { CostAnalyticsService } from './application/services/CostAnalyticsService.js';
import { DataIngestionService } from './application/services/DataIngestionService.js';
import { FinOpsAiService } from './application/services/FinOpsAiService.js';
import { KnowledgeGraphService } from './application/services/KnowledgeGraphService.js';
import { SavingsReminderService } from './application/services/SavingsReminderService.js';
import { TelegramBotService } from './application/services/TelegramBotService.js';
import { TelegramClient } from './application/services/TelegramClient.js';
import { TelegramLinkService } from './application/services/TelegramLinkService.js';
import { TelegramMessageFormatter } from './application/services/TelegramMessageFormatter.js';
import { AWSProvider } from './infrastructure/providers/aws/AWSProvider.js';
import { getPrismaClient } from './infrastructure/database/prisma.js';
import { OpenAiCompatibleAiGateway } from './infrastructure/ai/OpenAiCompatibleAiGateway.js';
import { PrismaAgentContextRepository } from './infrastructure/repositories/PrismaAgentContextRepository.js';
import { PrismaAgentLearningRepository } from './infrastructure/repositories/PrismaAgentLearningRepository.js';
import { PrismaCloudConnectionRepository } from './infrastructure/repositories/PrismaCloudConnectionRepository.js';
import { PrismaCostAnalyticsRepository } from './infrastructure/repositories/PrismaCostAnalyticsRepository.js';
import { PrismaCostRepository } from './infrastructure/repositories/PrismaCostRepository.js';
import { PrismaNotificationRepository } from './infrastructure/repositories/PrismaNotificationRepository.js';
import { PrismaRecommendationRepository } from './infrastructure/repositories/PrismaRecommendationRepository.js';
import { PrismaTelegramRepository } from './infrastructure/repositories/PrismaTelegramRepository.js';
import { PrismaUserRepository } from './infrastructure/repositories/PrismaUserRepository.js';
import { Argon2PasswordHasher } from './infrastructure/security/Argon2PasswordHasher.js';
import { JwtTokenService } from './infrastructure/security/JwtTokenService.js';

/**
 * Composición Raíz — Configuración y arranque de la aplicación.
 */
async function bootstrap(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   FinOps Inteligente — Optimizador de Costos en la Nube      ║
║   FinOps Demo © 2026                                        ║
║   Providers: AWS + Oracle Cloud (OCI)                        ║
╚═══════════════════════════════════════════════════════════════╝
  `);

  // ── 1. Instanciar Adaptadores ─────────────────────────────────
  //
  // Cada proveedor se inicializa dentro de un try/catch para que
  // la app no muera si un proveedor no tiene credenciales configuradas.
  // Los proveedores que fallen se registran como warning y se omiten.

  const providerRegistry = new Map<string, ICloudProvider>();

  /**
   * AWS Provider
   * Las credenciales se resuelven automáticamente vía:
   *   - Variables de entorno: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
   *   - Shared credentials file: ~/.aws/credentials
   *   - IAM Role (EC2/ECS)
   */
  try {
    const awsProvider = new AWSProvider({
      region: process.env['AWS_REGION'] ?? 'us-east-1',
    });
    providerRegistry.set(awsProvider.providerName, awsProvider);
    console.log('  ✓ AWS Provider initialized');
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`  ⚠ AWS Provider skipped (init failed): ${msg}`);
  }

  /**
   * Oracle Cloud Provider
   * Credenciales leídas desde ~/.oci/config (formato estándar OCI CLI).
   * El tenancyId se obtiene automáticamente del auth provider.
   *
   * En producción, usar Instance Principals o Resource Principals.
   */
  try {
    if (process.env['ENABLE_OCI_PROVIDER'] === 'true') {
      const { OCIProvider } = await import('./infrastructure/providers/oci/OCIProvider.js');
      const ociProvider = new OCIProvider();
      providerRegistry.set(ociProvider.providerName, ociProvider);
      console.log('  ✓ OCI Provider initialized');
    } else {
      console.log('  ℹ OCI Provider disabled (set ENABLE_OCI_PROVIDER=true to enable)');
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`  ⚠ OCI Provider skipped (init failed): ${msg}`);
  }

  // ── 2. Registrar Proveedores (Dependency Injection) ───────────

  // ── 3. Instanciar Servicio de Ingesta ─────────────────────────

  const prisma = getPrismaClient();
  const cloudConnectionRepository = new PrismaCloudConnectionRepository(prisma);
  const costAnalyticsRepository = new PrismaCostAnalyticsRepository(prisma);
  const costRepository = new PrismaCostRepository(prisma);
  const recommendationRepository = new PrismaRecommendationRepository(prisma);
  const notificationRepository = new PrismaNotificationRepository(prisma);
  const telegramRepository = new PrismaTelegramRepository(prisma);
  const agentContextRepository = new PrismaAgentContextRepository(prisma);
  const agentLearningRepository = new PrismaAgentLearningRepository(prisma);
  const userRepository = new PrismaUserRepository(prisma);
  const passwordHasher = new Argon2PasswordHasher();
  const tokenService = new JwtTokenService();
  const authService = new AuthService(userRepository, passwordHasher, tokenService);
  const cloudConnectionService = new CloudConnectionService(cloudConnectionRepository);
  const analyticsService = new CostAnalyticsService(costAnalyticsRepository);
  const savingsReminderService = new SavingsReminderService(recommendationRepository, notificationRepository);
  const aiGateway = new OpenAiCompatibleAiGateway();
  const agentInstructionService = new AgentInstructionService(agentContextRepository);
  const learningService = new AgentLearningService(
    recommendationRepository,
    agentLearningRepository,
    aiGateway,
  );
  const contextEngineService = new ContextEngineService(
    agentContextRepository,
    agentInstructionService,
    learningService,
  );
  const aiObservabilityService = new AiObservabilityService(agentContextRepository);
  const contextSummaryBuilderService = new ContextSummaryBuilderService(agentContextRepository);
  const knowledgeGraphService = new KnowledgeGraphService(agentContextRepository);
  const aiService = new FinOpsAiService(
    costAnalyticsRepository,
    recommendationRepository,
    aiGateway,
    learningService,
    contextEngineService,
    aiObservabilityService,
  );
  const telegramEnabled = process.env['TELEGRAM_ENABLED'] === 'true';
  const telegramClient = new TelegramClient(process.env['TELEGRAM_BOT_TOKEN'], telegramEnabled);
  const telegramMessageFormatter = new TelegramMessageFormatter();
  const telegramLinkService = new TelegramLinkService(telegramRepository, telegramClient);
  const telegramBotService = new TelegramBotService(
    telegramRepository,
    telegramClient,
    telegramMessageFormatter,
    aiService,
    savingsReminderService,
    recommendationRepository,
    costAnalyticsRepository,
    process.env['TELEGRAM_BOT_USERNAME'],
  );
  const ingestionService = new DataIngestionService(providerRegistry, costRepository);

  // ── 4. Iniciar Servidor RESTful ───────────────────────────────────

  const { createExpressServer } = await import('./presentation/server.js');
  const app = createExpressServer({
    authService,
    cloudConnectionService,
    analyticsService,
    aiService,
    agentInstructionService,
    agentContextRepository,
    contextSummaryBuilderService,
    knowledgeGraphService,
    savingsReminderService,
    telegramBotService,
    telegramLinkService,
    ...(process.env['TELEGRAM_WEBHOOK_SECRET'] !== undefined
      ? { telegramWebhookSecret: process.env['TELEGRAM_WEBHOOK_SECRET'] }
      : {}),
    telegramEnabled,
    learningService,
    costRepository,
    recommendationRepository,
    tokenService,
  });
  
  const PORT = process.env['PORT'] || 3000;
  
  app.listen(PORT, () => {
    console.log(`\n🚀 FinOps Backend API running on http://localhost:${PORT}`);
    console.log(`   Registered providers: [${ingestionService.getRegisteredProviders().join(', ')}]`);
    console.log(`   Auth: POST http://localhost:${PORT}/api/v1/auth/login`);
    console.log(`   Cloud Connections: GET http://localhost:${PORT}/api/v1/cloud-connections`);
    console.log(`   Costs: GET http://localhost:${PORT}/api/v1/costs?provider=oci&startDate=...&endDate=...`);
    console.log(`   Recommendations: GET http://localhost:${PORT}/api/v1/recommendations`);
  });
}

// ── Ejecución ─────────────────────────────────────────────────────
bootstrap().catch((error: unknown) => {
  console.error('💥 Fatal error during bootstrap:', error);
  process.exit(1);
});
