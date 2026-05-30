# Plan de refactorización — finops-backend (handoff para agente CLI)

> Documento autocontenido. Objetivo: dejar **todos los archivos de código propio bajo 200 líneas efectivas** (código real, sin comentarios JSDoc ni líneas en blanco), sin cambiar comportamiento funcional, preservando contratos de API y dejando typecheck + tests en verde.

---

## 0. Contexto del proyecto

- **Stack:** Node.js + TypeScript estricto (ESM, `"type": "module"`, `module: NodeNext`). Backend-only. No hay frontend en este repo (el `react` en `node_modules` es transitivo, no está en `package.json`).
- **Arquitectura:** Clean Architecture por capas:
  - `src/domain/` — modelos, interfaces (puertos), errores. Sin dependencias de framework.
  - `src/application/services/` — casos de uso / servicios de aplicación.
  - `src/infrastructure/` — adaptadores: repositorios Prisma, gateways IA, providers cloud, seguridad, ingesta, seed.
  - `src/presentation/` — controladores Express, rutas, middleware.
- **ORM:** Prisma (cliente generado en `src/generated/prisma/` — **NO TOCAR**, está en `.gitignore`).
- **Imports ESM:** SIEMPRE con extensión `.js` en los imports relativos (aunque el archivo sea `.ts`). Ej.: `import { x } from './foo.js'`.
- **Path aliases** existen (`@domain/*`, etc.) pero el código usa imports relativos; mantener el estilo relativo.

### Comandos de verificación (los únicos disponibles)
```bash
npx tsc --noEmit          # typecheck (NO uses "npm run typecheck": corre prisma generate y puede colgarse sin DB)
npm test                  # vitest run — suite completa (debe quedar 41/41 passed)
npx vitest run <ruta>     # un archivo de test concreto
```
- **No existe `lint`** (no hay ESLint configurado). No lo intentes.
- **No existe build separado** relevante más allá de `tsc`.
- `getDiagnostics` del IDE es útil para ver errores por archivo sin correr todo `tsc`.

### Regla de medición de "líneas efectivas"
Una línea cuenta como efectiva si, tras `trim`, **no** está vacía y **no** empieza por `//`, `/*`, `*` ni es `*/`. Snippet PowerShell de referencia (úsalo para verificar el objetivo <200):
```powershell
Get-ChildItem -Recurse -Path src -Filter *.ts | Where-Object { $_.FullName -notmatch 'generated' -and $_.Name -notmatch '\.test\.ts$' -and $_.Name -notmatch '\.d\.ts$' } | ForEach-Object { $raw = Get-Content $_.FullName; $eff = ($raw | Where-Object { $t = $_.Trim(); $t -ne '' -and -not $t.StartsWith('//') -and -not $t.StartsWith('/*') -and -not $t.StartsWith('*') -and $t -ne '*/' }).Count; if ($eff -gt 200) { "{0,4} eff  {1}" -f $eff,$_.FullName } } | Sort-Object -Descending
```

---

## 1. Reglas obligatorias (heredadas del encargo original)

1. Ningún archivo de código propio debe superar **200 líneas efectivas**, salvo excepción justificada (ver §5).
2. Al dividir, cada módulo nuevo debe tener **una responsabilidad clara** (SRP). Nada de troceo mecánico.
3. Funciones: idealmente <40 líneas; extraer pasos con nombres claros; evitar anidación profunda.
4. Evitar "God objects" y duplicación; extraer abstracciones simples solo cuando aportan.
5. No introducir abstracciones innecesarias.
6. Respetar la separación por capas. No mezclar acceso a datos, lógica de negocio y presentación.
7. **No cambiar contratos públicos de API** (rutas HTTP, status codes, forma de request/response) salvo que sea imprescindible; si ocurre, documentarlo.
8. No eliminar funcionalidad. No borrar migraciones, datos ni configuración.
9. Mantener nombres orientados al dominio FinOps.
10. **No tocar** `src/generated/prisma/`.
11. Solo se **añaden/mueven** comentarios JSDoc; el código ya está documentado en español — preserva ese estilo y muévelo junto con el código extraído.
12. Tras **cada** bloque de cambios: `npx tsc --noEmit` y `npm test`. Si algo falla, corrígelo antes de seguir.

### Invariantes críticos (NO romper — verificados por tests)
- **Prompts IA literales:** los strings de `finOpsAiPrompts.ts` y de los prompts de auditoría/learning son contractuales (los tests verifican substrings como `'español'`, `'agente auditor'`, `'auditor de aprendizaje'`, `'Contexto de aprendizaje auditado'`). NO los edites al mover.
- **Orden y número de llamadas al gateway IA:** `FinOpsAiService.test.ts` cuenta `gateway.requests` (p. ej. 2 llamadas para generar+auditar, 4 para revisión). Preserva la secuencia generar→auditar→(revisar→auditar).
- **Status codes y `code` de error** de los controladores (`AUTHENTICATION_REQUIRED`, `AUTHORIZATION_FAILED`, `VALIDATION_ERROR`, `NOT_FOUND`, `AI_AUDIT_REJECTED`, etc.) son verificados por tests de controladores.
- **Aislamiento multi-tenant:** todas las consultas de repos filtran por `tenantId` (a veces vía relación). No alterar esos `where`.

---

## 2. Trabajo ya completado (NO rehacer)

Refactors aplicados y verificados (tsc 0, 41/41 tests):

- **`CostAnalyticsService.ts`** (450→~135 ef.). Extraído a `src/application/services/analytics/`:
  `statistics.ts`, `costSeriesGrouping.ts`, `anomalyDetector.ts`, `costForecaster.ts`, `costTrendBuilder.ts`, `usageInsightBuilder.ts`.
- **`FinOpsAiService.ts`** (741→278 ef.). Extraído a `src/application/services/ai/`:
  `finOpsAiTypes.ts`, `finOpsAiPrompts.ts`, `finOpsAiResponseParser.ts`, `aiTraceRecorder.ts`, `finOpsArtifactGenerator.ts`. (Sigue en 278; ver tarea T-06.)
- **`PrismaCostAnalyticsRepository.ts`** (609→257 ef.). Extraído a:
  `src/infrastructure/repositories/mappers/costAnalyticsMappers.ts`,
  `src/infrastructure/repositories/queries/costAnalyticsSnapshotQueries.ts`,
  `src/infrastructure/repositories/queries/costAnalyticsSeriesQueries.ts`. (Sigue en 257; ver T-07.)
- **`PrismaRecommendationRepository.ts`** — mappers extraídos a `mappers/recommendationMappers.ts` (sigue en 404; ver T-01).
- Otros ya bajo 200 por trabajo previo: `PrismaTelegramRepository`, `focusSample`→`focusSampleRowMapper` parcial, `ociFocusReport`.

**Convenciones de extracción ya establecidas (síguelas):**
- Mappers puros (fila Prisma/cruda → dominio) → `src/infrastructure/repositories/mappers/<area>Mappers.ts`.
- Consultas SQL crudas (`$queryRaw`) y construcción de cláusulas → `src/infrastructure/repositories/queries/<area>Queries.ts`.
- Helpers puros de servicio (prompts, parsing, estadística, formato) → subcarpeta por dominio dentro de `services/` (`ai/`, `analytics/`, etc.).
- Los módulos extraídos **NO** importan de su repositorio/servicio (evitar ciclos). Las funciones puras reciben `prisma`/`tx` por parámetro cuando necesitan DB.

---

## 3. Archivos pendientes (estado medido) y plan por archivo

Orden sugerido: de mayor a menor impacto. Hacer **un archivo (o grupo) por bloque**, verificar, commitear mentalmente, seguir.

| ID | Archivo | Efectivas | Test que lo protege |
|----|---------|-----------|---------------------|
| T-01 | `src/infrastructure/repositories/PrismaRecommendationRepository.ts` | 404 | `presentation/controllers/RecommendationController.test.ts` (indirecto) |
| T-02 | `src/infrastructure/repositories/PrismaAgentContextRepository.ts` | 399 | — (sin test directo) |
| T-03 | `src/infrastructure/repositories/PrismaAgentLearningRepository.ts` | 301 | `AgentLearningService.test.ts` (indirecto, usa fake) |
| T-04 | `src/presentation/controllers/RecommendationController.ts` | 299 | `RecommendationController.test.ts` |
| T-05 | `src/application/services/TelegramBotService.ts` | 279 | `TelegramBotService.test.ts` |
| T-06 | `src/application/services/FinOpsAiService.ts` | 278 | `FinOpsAiService.test.ts` |
| T-07 | `src/infrastructure/repositories/PrismaCostAnalyticsRepository.ts` | 257 | `CostAnalyticsService.test.ts` (indirecto) |
| T-08 | `src/application/services/AgentInstructionService.ts` | 226 | — |
| T-09 | `src/infrastructure/seed/focusSampleRowMapper.ts` | 226 | `focusSample.test.ts` |
| T-10 | `src/domain/interfaces/ICostAnalyticsRepository.ts` | 222 | — (solo tipos → ver §5) |
| T-11 | `src/application/services/ai/finOpsAiResponseParser.ts` | 211 | `FinOpsAiService.test.ts` (indirecto) |
| T-12 | `src/infrastructure/repositories/PrismaCloudConnectionRepository.ts` | 202 | `CloudConnectionService.test.ts` (indirecto) |

---

### T-01 · PrismaRecommendationRepository (404)
**Problema:** acceso a datos transaccional voluminoso (decisiones, ejecuciones manuales, timeline, KPIs de ahorro/adopción) en una sola clase.
**Plan:**
- Extraer la construcción de la **timeline** (`findTimelineByRecommendation`) a `queries/recommendationTimeline.ts`: una función pura `buildTimelineEvents(recommendation, plans, decisions, executions, learningEvents)` que arma y ordena el array `RecommendationTimelineEvent[]`. El repo solo hace los `findMany` en paralelo y delega el ensamblado.
- Extraer el **cálculo de KPIs** (`getSavingsKpis`, `getAdoptionKpis`) a un colaborador `RecommendationKpiQueries` en `queries/recommendationKpiQueries.ts` (recibe `prisma`), o helpers puros para la parte de cálculo (missed savings, tasas) — parte ya está en `mappers/recommendationMappers.ts` (`calculateMissedSavings`, `roundCurrency`), reutilízalos.
- Mantener en el repo: CRUD simple (`findById`, `findByTenant`, `createMany`, `createExecutionPlan`, `findExecutionPlanById`, `findLatestExecutionPlanByRecommendation`, `createDecision`, `createManualExecution`, `findManualExecutionsByRecommendation`).
**Riesgo:** medio (transacciones e invariantes de estado). **No cambiar** los `throw new Error('...')` ni las transiciones de estado (`MARKED_DONE`→`MANUAL_COMPLETED`, etc.).
**Checks:** `tsc` + `npm test` (RecommendationController.test ejercita el repo vía fakes, pero el repo real no tiene test unitario; cuidar firmas públicas de `IRecommendationRepository`).

### T-02 · PrismaAgentContextRepository (399)
**Problema:** repo "god" que cubre perfiles de instrucciones (versionado), reglas de tenant, caché de resúmenes, trazas IA, agregación FOCUS (`$queryRaw`) y grafo de conocimiento (BFS por niveles).
**Plan:** dividir por sub-dominio:
- `queries/agentContextFocusQueries.ts` — la(s) consulta(s) `$queryRaw` de agregación FOCUS y su interface de fila cruda.
- `queries/agentKnowledgeGraphQueries.ts` — la lógica de grafo (vista general vs BFS por niveles con profundidad acotada) como funciones que reciben `prisma`.
- `mappers/agentContextMappers.ts` — mappers fila→dominio (perfil, regla, traza, nodo/arista de grafo).
- El repo mantiene la orquestación de perfiles/reglas/caché/trazas (CRUD).
**Riesgo:** medio. Preservar el invariante de "un solo perfil ACTIVE" y la profundidad acotada del BFS.
**Checks:** `tsc` + `npm test`. No hay test directo; máxima cautela con la interfaz `IAgentContextRepository`.

### T-03 · PrismaAgentLearningRepository (301)
**Problema:** eventos de aprendizaje + memorias LOCAL/GLOBAL + contexto con full-text search en español + conteo de patrones cross-tenant.
**Plan:**
- `queries/agentLearningSearchQueries.ts` — la consulta de `findRecommendationLearningContext` (full-text `to_tsvector('spanish', ...)`/`plainto_tsquery`) y `countSimilarApprovedEvents`, con sus interfaces de fila cruda.
- `mappers/agentLearningMappers.ts` — mappers fila→dominio (evento, memoria).
- El repo mantiene CRUD de eventos/memorias.
**Riesgo:** medio. **No alterar** el SQL de full-text (idioma `'spanish'` es semántico). El test `AgentLearningService.test.ts` usa un fake del repo, así que protege al servicio, no al repo real → cuidar firmas de `IAgentLearningRepository`.

### T-04 · RecommendationController (299)
**Problema:** 7 handlers + parsers/validadores embebidos + mapeo error→status.
**Plan:**
- Extraer parsers/validadores a `presentation/controllers/recommendation/recommendationRequestParsers.ts` (funciones puras): `parseDecision`, `parseManualExecutionStatus`, `parseReasonCode`, `parseStatus`, `parseDate`, `parseNumber`, `parseString`, `readBodyValue`, y los `Set` de valores soportados.
- Extraer el mapeo error→status y `processLearningSafely` a un helper `recommendation/recommendationResponse.ts` (o dejar `handleError` como helper compartido de presentación).
- El controller queda con los handlers delgados que llaman parsers + servicio/repo y responden.
**Riesgo:** bajo. **Preservar exactamente** status codes (`401/403/400/404/409/200`) y `code`s; los tests verifican: forbid no-admin (403 `AUTHORIZATION_FAILED`), reason code requerido al aprobar/rechazar (400 `VALIDATION_ERROR`), aprobación admin (200 + `learning` PENDING eventId), y el shape de `latestExecutionPlan`.
**Checks:** `npx vitest run src/presentation/controllers/RecommendationController.test.ts`.

### T-05 · TelegramBotService (279)
**Problema:** orquestación del canal + parsing de updates + formato de respuestas (savings, recomendaciones, costos, oportunidades) embebido.
**Plan:**
- Extraer los **formatters de respuesta** a `application/services/telegram/telegramReplyFormatter.ts` (puros): `formatSavingsReminders`, `formatRecommendations`, `formatCosts`, `formatOpportunities`, `formatRecommendationLine`, helpers `truncatePreview`/`formatDate`/`formatCurrency` y el `currencyFormatter`.
- Extraer el **parsing de updates** a `telegram/telegramUpdateParser.ts` (puros): `parseMessage`, `parseCommand` y sus tipos `ParsedTelegramMessage`/`ParsedCommand`/`TelegramUpdate`.
- El servicio mantiene: `handleUpdate`, ruteo (`handleUnlinkedMessage`, `buildLinkedReply`, `answerChat`), `sendChunks`, `logMessage`.
**Riesgo:** medio. Tests verifican substrings exactos: `'Chat ID: 12345'`, que NO aparezca `'Costo total'` en chat no vinculado, `'Recordatorios de ahorro'`, `'Sabias que te podrias haber ahorrado'`, `'no esta vinculado'`, y el ruteo a `aiService.answerChat` con `{tenantId, userId, message}`. Preserva esos textos y el flujo de autorización (usuario DISABLED → ignorado).
**Checks:** `npx vitest run src/application/services/TelegramBotService.test.ts`.

### T-06 · FinOpsAiService (278) — terminar de bajar de 200
**Problema:** aún concentra 3 casos de uso + preparación de contexto/snapshot + trazas de alto nivel + `applyAuditEvidence`.
**Plan (opción recomendada, sin trocear en clases por-caso-de-uso):**
- Extraer un colaborador `ai/finOpsContextAssembler.ts` que encapsule: `buildOptionalContext` (Context Engine), `getRecommendationLearningContext` y la construcción del `systemPrompt` final (combinando `withBuiltContext` + el builder correspondiente). El servicio le pide "dame el contexto+prompt para CHAT/RECOMMENDATION/EXECUTION_PLAN".
- Mover `applyAuditEvidence` a `finOpsAiResponseParser.ts` o a un pequeño `ai/recommendationEvidence.ts` (función pura `applyAuditEvidence(draft, auditReport, learningContext)`).
- El servicio queda: validar input → pedir snapshot → pedir contexto/prompt al assembler → delegar en `artifactGenerator` → persistir → traza.
**Riesgo:** bajo/medio. Mantener orden de llamadas al gateway (test cuenta requests) y el reexport de tipos públicos (`export type { AiChatMessage, ... }`).
**Checks:** `npx vitest run src/application/services/FinOpsAiService.test.ts`.

### T-07 · PrismaCostAnalyticsRepository (257)
**Problema:** quedan `replaceAnomalies`/`replaceForecasts` (transacciones con `pg_advisory_xact_lock` + `createMany` con mapeo inline de inputs) y `findAnomalies`/`findForecasts`.
**Plan:**
- Extraer a `queries/costAnalyticsPersistenceQueries.ts` las dos operaciones de reemplazo transaccional (reciben `prisma` + el array a persistir y devuelven filas), y/o extraer el mapeo `PersistCostAnomalyInput→data` y `PersistCostForecastInput→data` a funciones puras en `mappers/costAnalyticsMappers.ts` (`toAnomalyCreateData`, `toForecastCreateData`).
- El repo mantiene `getLatestTenantSnapshot` (ya delega), las dos series (ya delegan) y `findAnomalies/findForecasts`.
**Riesgo:** bajo. **No cambiar** el patrón de lock (`pg_advisory_xact_lock(hashtext('cost_anomalies:'+tenantId))`) ni `skipDuplicates`. `CostAnalyticsService.test.ts` verifica `maxConcurrentForecastReplacements === 1` (serialización) — eso vive en el servicio, no en el repo, pero no toques la semántica transaccional.

### T-08 · AgentInstructionService (226)
**Problema:** validación de seguridad (lista negra de patrones, validación de perfil, conflictos con perfil global) mezclada con el caso de uso.
**Plan:**
- Extraer a `application/services/agentInstruction/agentInstructionValidation.ts` (puros): `forbiddenInstructionPatterns`, `validateProfile`, `validateFreeText`, `contradictsGlobalTak`, `filterRulesAgainstProfile` (la parte pura) y `defaultProfile`.
- El servicio mantiene los casos de uso (`getActiveProfile`, `validateAndActivateProfile`, `listTenantRules`, `createTenantRule`, `disableTenantRule`) y la autorización (`assertCanAdminAgent`).
**Riesgo:** bajo. Preservar mensajes de error en español y el umbral de objetivo ≥20 chars / perfil ≤8000 / advertencia >4000.

### T-09 · focusSampleRowMapper (226)
**Problema:** parsing/normalización FOCUS con helpers (`stringOrNull`, `numberOrNull`, `dateOrNull`, `parseTags`, `parseProvider`) + builder de filas + hash.
**Plan:**
- Si ya existe duplicación con `infrastructure/ingestion/ociFocusReport.ts`, extraer los helpers comunes de parsing FOCUS a `infrastructure/ingestion/focusParsing.ts` (o `infrastructure/seed/focusFieldParsers.ts`) y reutilizar en ambos.
- Separar `buildCostMetricSeedRows`/`buildMetricIdentityHash` (mapeo a filas Prisma) de los parsers de campo.
**Riesgo:** medio (hay test `focusSample.test.ts`). **No cambiar** el formato de fecha (`new Date(\`${s.replace(' ','T')}Z\`)`), ni el cálculo del `metricIdentityHash` (incluye `index`), ni el filtrado de filas inválidas.
**Checks:** `npx vitest run src/infrastructure/seed/focusSample.test.ts` (y `ociFocusReport.test.ts` si tocas el módulo común).

### T-10 · ICostAnalyticsRepository (222) — SOLO TIPOS
**Decisión:** es un archivo de **solo declaraciones de tipos/interfaces** cohesionadas (un único puerto + sus DTOs). Dividirlo perjudica la trazabilidad sin beneficio real.
**Plan (opcional):** si se quiere bajar de 200, separar los DTOs de salida (`CostAnalyticsSnapshot` y sus items, `MonthlyCostPoint`, `MonthlyUsagePoint`, `CostAnomaly`, `CostForecast`, `UsageInsight`, `CostTrend`) a `domain/interfaces/costAnalytics/` y dejar la interfaz `ICostAnalyticsRepository` + inputs de persistencia en el archivo principal, reexportando. Si no, **dejar como excepción justificada** (ver §5).
**Riesgo:** bajo, pero muchos imports apuntan aquí; si se divide, mantener un reexport para no romper rutas de import existentes.

### T-11 · ai/finOpsAiResponseParser (211)
**Problema:** parsers de recomendaciones, plan y auditoría + helpers (`isRecord`, `readString`, `readNumber`, `readEvidenceLevel`, `readStringList`, `extractJson`).
**Plan:**
- Extraer los helpers genéricos de lectura segura de JSON a `ai/jsonReadHelpers.ts` (`isRecord`, `readString`, `readNumber`, `readStringList`, `extractJson`).
- Dejar en `finOpsAiResponseParser.ts` los parsers de dominio (`parseRecommendationDrafts`, `parseExecutionPlan`, `parseAuditReport`, `toRecommendationDraft`, `toEphemeralRecommendation`, `readEvidenceLevel`).
**Riesgo:** bajo. **No cambiar** los mensajes `AI_RESPONSE_ERROR` ni la validación de severidades/verdict/score.

### T-12 · PrismaCloudConnectionRepository (202)
**Problema:** apenas por encima del umbral; catálogo + conexiones + jobs + salud de ingesta + mappers.
**Plan:**
- Extraer mappers fila→dominio a `mappers/cloudConnectionMappers.ts` (`mapProvider`, `mapCloudConnection`, `isJsonObject`, `countJobs` si es puro). Con eso baja de 200.
**Riesgo:** bajo. `CloudConnectionService.test.ts` usa fake; cuidar firmas de `ICloudConnectionRepository`.

---

## 4. Protocolo de ejecución por bloque (repetir para cada T-xx)

1. Leer el archivo COMPLETO (`skipPruning`) y su `*.test.ts` si existe.
2. Crear los módulos nuevos (mappers/queries/helpers) moviendo el código **tal cual** (sin reescribir lógica). Mover también su JSDoc.
3. Actualizar el archivo original: importar lo movido, sustituir `this.x(...)`→`x(...)` donde aplique, borrar lo movido, limpiar imports sin uso.
4. `getDiagnostics` sobre los archivos tocados → 0 errores.
5. `npx tsc --noEmit` → exit 0.
6. `npm test` → 41/41 passed (o el número vigente; nunca menos que antes).
7. Medir líneas efectivas del archivo objetivo (snippet §0) → confirmar <200 o justificar.
8. Pasar al siguiente bloque.

> Paralelización: T-01..T-03 (repos), T-04/T-08 (presentación+servicio), T-05, T-11 tocan archivos disjuntos y pueden hacerse en paralelo por subagentes. T-06, T-07, T-09, T-11 comparten carpeta `ai/`/`analytics/`/`ingestion` con trabajo previo — si se paralelizan, asignar carpetas disjuntas para evitar colisiones de import. Verificar `tsc`+`npm test` **al unificar**, no solo por subagente.

---

## 5. Excepciones aceptables (documentar si se dejan >200)

- `ICostAnalyticsRepository.ts` (T-10): archivo de solo tipos cohesionados; dividir reduce trazabilidad. Aceptable como excepción si se prefiere no fragmentar el puerto.
- Repos Prisma cuyo volumen restante sea **acceso a datos legítimo** (consultas/transacciones que no se pueden trocear sin inventar abstracciones artificiales). En esos casos, tras extraer mappers y queries, si quedan ~210–230 ef. de puro CRUD, es preferible la cohesión a forzar el corte. **Justificar explícitamente** en el resumen final.

---

## 6. Criterio de éxito

- `npx tsc --noEmit` → exit 0.
- `npm test` → todos los tests passed (≥ 41).
- Sin pérdida de comportamiento; contratos de API y de tests intactos.
- Archivos propios <200 líneas efectivas, salvo excepciones justificadas de §5.
- Sin imports circulares; módulos nuevos con responsabilidad única y JSDoc en español.

---

## 7. Resumen final que debe entregar el ejecutor

- Lista de archivos refactorizados y módulos nuevos creados (con líneas efectivas resultantes).
- Archivos que siguen >200 y justificación.
- Resultado de `tsc` y `npm test`.
- Riesgos pendientes / deuda restante.
