/**
 * ═══════════════════════════════════════════════════════════════
 * FinOps Inteligente — Entry Point (Composition Root)
 * ═══════════════════════════════════════════════════════════════
 *
 * Punto de entrada principal de la aplicación. La composición de dependencias
 * vive en `bootstrap/applicationComposition.ts`; este archivo coordina los
 * roles de proceso, el servidor HTTP, workers, schedulers y el cierre ordenado.
 *
 * @module index
 */

import 'dotenv/config';

import { safeErrorMessage } from './application/observability/safeError.js';
import { createApplicationComposition } from './bootstrap/applicationComposition.js';
import { startBackgroundProcesses } from './bootstrap/backgroundProcessRuntime.js';
import { loadRuntimeConfig } from './infrastructure/config/runtimeConfigReader.js';
import { createExpressServer } from './presentation/server.js';
import { startNonOverlappingLoop, type NonOverlappingLoopHandle, type NonOverlappingLoopOptions } from './application/services/NonOverlappingLoop.js';


/**
 * Arranque de los roles de proceso y del servidor HTTP.
 *
 * Aquí se ensambla todo el grafo de dependencias de forma manual y se
 * arranca el servidor HTTP. Pasos principales:
 *
 * La configuración se lee una sola vez mediante `loadRuntimeConfig` y se
 * comparte con la composición y la capa HTTP.
 *
 * @returns Promesa que se resuelve una vez el servidor HTTP queda escuchando.
 */
async function bootstrap(): Promise<void> {
  const config = loadRuntimeConfig();
  const processRole = config.environment.processRole;
  const runsApi = processRole === 'api' || processRole === 'all';
  const runsWorkers = processRole === 'worker' || processRole === 'all';
  const runsSchedulers = processRole === 'scheduler' || processRole === 'all';

  console.log('\nFinOps Inteligente — Optimizador de Costos en la Nube\nFinOps Demo © 2026\nProviders: AWS + Oracle Cloud (OCI)\n');

  const composition = createApplicationComposition(runsWorkers, config);
  const { prisma, serverDependencies } = composition;
  const app = runsApi ? createExpressServer(serverDependencies) : undefined;
  const backgroundStops: Array<() => Promise<void>> = [];
  const startBackgroundLoop = (options: NonOverlappingLoopOptions): void => {
    const handle: NonOverlappingLoopHandle = startNonOverlappingLoop(options);
    backgroundStops.push(async () => {
      handle.stop();
      await handle.waitForIdle();
    });
  };
  const stopBackgroundWork = async (): Promise<void> => {
    const stops = backgroundStops.splice(0);
    await Promise.all(stops.map((stop) => stop()));
  };

  // ── 4. Iniciar Servidor RESTful ───────────────────────────────────
  const PORT = config.http.port;

  const httpServer = app?.listen(PORT, () => {
    console.log(
      '\nFinOps Backend API running on http://localhost:' + PORT +
      '\nIngestion providers: AWS SDK + OCI SDK' +
      '\nAuth: POST http://localhost:' + PORT + '/api/v1/auth/login' +
      '\nCloud Connections: GET http://localhost:' + PORT + '/api/v1/cloud-connections' +
      '\nCosts: GET http://localhost:' + PORT + '/api/v1/costs?provider=oci&startDate=...&endDate=...' +
      '\nRecommendations: GET http://localhost:' + PORT + '/api/v1/recommendations',
    );
  });
  if (httpServer !== undefined) {
    httpServer.requestTimeout = config.http.requestTimeoutMs;
    httpServer.headersTimeout = Math.min(
      config.http.headersTimeoutMs,
      httpServer.requestTimeout,
    );
    httpServer.keepAliveTimeout = config.http.keepAliveTimeoutMs;
  } else {
    console.log('   Process role: ' + processRole + ' (HTTP API disabled)');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }));
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    await stopBackgroundWork();
    const disconnect = (): void => {
      void prisma.$disconnect()
        .catch((error: unknown) => {
          console.error(JSON.stringify({
            level: 'error',
            event: 'shutdown_database_disconnect_failed',
            errorName: error instanceof Error ? error.name : 'UnknownError',
          }));
        })
        .finally(() => {
          clearTimeout(forceExit);
          process.exit(0);
        });
    };
    if (httpServer === undefined) {
      disconnect();
      return;
    }
    httpServer.close(disconnect);
  };
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  startBackgroundProcesses({
    config,
    runsWorkers,
    runsSchedulers,
    composition,
    startBackgroundLoop,
    registerStop: (stop) => backgroundStops.push(stop),
  });
}

// ── Ejecución ─────────────────────────────────────────────────────
//
// Arranca la Composición Raíz. Si `bootstrap` rechaza la promesa por un
// error no controlado durante el arranque, se registra como error fatal y
// el proceso termina con código de salida `1` para que el orquestador
// (Docker, PM2, systemd, etc.) detecte el fallo y reinicie si procede.
bootstrap().catch((error: unknown) => {
  console.error(JSON.stringify({ level: 'error', event: 'bootstrap_failed', error: safeErrorMessage(error) }));
  process.exit(1);
});
