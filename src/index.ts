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
import { DataIngestionService } from './application/services/DataIngestionService.js';
import { AWSProvider } from './infrastructure/providers/aws/AWSProvider.js';
import { OCIProvider } from './infrastructure/providers/oci/OCIProvider.js';
import { FinOpsBaseError } from './domain/errors/errors.js';

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
    const ociProvider = new OCIProvider();
    providerRegistry.set(ociProvider.providerName, ociProvider);
    console.log('  ✓ OCI Provider initialized');
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`  ⚠ OCI Provider skipped (init failed): ${msg}`);
  }

  // ── 2. Registrar Proveedores (Dependency Injection) ───────────

  // ── 3. Instanciar Servicio de Ingesta ─────────────────────────

  const ingestionService = new DataIngestionService(providerRegistry);

  // ── 4. Iniciar Servidor RESTful ───────────────────────────────────

  const { createExpressServer } = await import('./presentation/server.js');
  const app = createExpressServer(ingestionService);
  
  const PORT = process.env['PORT'] || 3000;
  
  app.listen(PORT, () => {
    console.log(`\n🚀 FinOps Backend API running on http://localhost:${PORT}`);
    console.log(`   Registered providers: [${ingestionService.getRegisteredProviders().join(', ')}]`);
    console.log(`   Endpoint: GET http://localhost:${PORT}/api/v1/costs?provider=oci&accountId=...`);
  });
}

// ── Ejecución ─────────────────────────────────────────────────────
bootstrap().catch((error: unknown) => {
  console.error('💥 Fatal error during bootstrap:', error);
  process.exit(1);
});
