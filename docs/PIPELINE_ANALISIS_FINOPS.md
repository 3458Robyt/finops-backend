# Pipeline gobernado de análisis FinOps

## Propósito

Convierte datos ya ingeridos en recomendaciones auditadas sin bloquear una petición HTTP ni
publicar resultados sin evidencia. No ejecuta cambios sobre OCI o AWS.

## Flujo

1. **Selección de datos:** obtiene costo y consumo FOCUS, inventario y métricas del tenant activo.
2. **Análisis determinístico:** calcula tendencias por moneda/unidad y evalúa reglas técnicas.
3. **Compuerta de evidencia:** separa candidatos elegibles de descartes explicables.
4. **Generación IA:** procesa como máximo los seis candidatos priorizados por la compuerta.
5. **Auditoría independiente:** valida evidencia, alcance, ahorro y seguridad.
6. **Persistencia:** reutiliza deduplicación factual y enlaza corrida con cada recomendación.
7. **Comunicación:** crea una notificación in-app solo cuando se publican recomendaciones nuevas.

Si no hay candidatos elegibles, la corrida termina como `SKIPPED` sin llamar al LLM. Si un lote se
reprocesa después de un reinicio, la deduplicación reutiliza las recomendaciones ya persistidas.
Los candidatos válidos fuera del lote de mayor impacto se conservan como aplazados con una razón
explícita; no se eliminan silenciosamente ni se incluyen en el prompt de ese lote.

## Estados y etapas

Estados terminales:

- `COMPLETED`: recomendaciones auditadas procesadas correctamente.
- `PARTIAL`: las recomendaciones se conservaron, pero falló una operación secundaria, o el auditor
  rechazó el artefacto completo.
- `SKIPPED`: evidencia insuficiente, evidencia sin cambios o ninguna oportunidad nueva.
- `FAILED`: se agotaron los intentos ante un fallo interno o externo.
- `CANCELLED`: una corrida todavía pendiente fue cancelada.

Estados activos: `PENDING` y `RUNNING`.

Etapas: `QUEUED`, `SELECTING_DATA`, `DETERMINISTIC_ANALYSIS`, `EVIDENCE_GATE`,
`AI_GENERATION`, `AI_AUDIT`, `PERSISTENCE`, `NOTIFICATION` y `FINISHED`.

## API

Todas las rutas requieren JWT y operan exclusivamente sobre el tenant activo:

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/api/v1/ai/analysis-runs/readiness` | Previsualiza período y evidencia sin llamar al LLM |
| `POST` | `/api/v1/ai/analysis-runs` | Encola y responde `202` |
| `GET` | `/api/v1/ai/analysis-runs` | Lista historial del tenant |
| `GET` | `/api/v1/ai/analysis-runs/:id` | Consulta detalle y recomendaciones enlazadas |
| `POST` | `/api/v1/ai/analysis-runs/:id/cancel` | Cancela únicamente una corrida pendiente |
| `POST` | `/api/v1/ai/analysis-runs/:id/retry` | Crea un reintento de una corrida fallida |

`MASTER_ADMIN`, `OPERATOR_ADMIN`, `ADMIN` y `FINOPS_TECHNICIAN` pueden modificar la cola. Los
roles de cliente y lectura solo consultan.

## Operación en desarrollo

```env
RECOMMENDATION_ANALYSIS_WORKER_ENABLED=true
RECOMMENDATION_ANALYSIS_WORKER_ID=finops-analysis-local
RECOMMENDATION_ANALYSIS_WORKER_INTERVAL_MS=5000
RECOMMENDATION_ANALYSIS_WORKER_STALE_AFTER_MS=1800000

# Automático post-ingesta: apagado por defecto.
RECOMMENDATION_ANALYSIS_SCHEDULER_ENABLED=false
RECOMMENDATION_ANALYSIS_SCHEDULER_INTERVAL_MS=300000
RECOMMENDATION_ANALYSIS_SCHEDULER_COOLDOWN_MINUTES=30
```

Con el worker apagado, las corridas permanecen en `PENDING` y se recuperan al volver a habilitarlo.
El scheduler no debe activarse durante desarrollo salvo una prueba deliberada.

## Diagnóstico

- **Permanece en pendiente:** confirmar que el worker está habilitado y que existe un único proceso
  con el `WORKER_ID` esperado.
- **Evidencia insuficiente:** revisar readiness, cobertura, frescura, vínculo de recurso y motivos de
  cada candidato. No es un fallo del proveedor IA.
- **Evidencia sin cambios:** la corrida equivalente ya terminó; no se repite el consumo de tokens.
- **Auditor rechazó:** no se publicó ninguna recomendación del artefacto rechazado. Revisar razones
  estructuradas, no prompts o payloads completos.
- **Fallo temporal del proveedor:** el repositorio programa reintentos acotados; al agotarlos queda
  `FAILED` y puede reintentarse explícitamente.
- **Notificación fallida:** la corrida queda `PARTIAL`; las recomendaciones ya publicadas no se
  eliminan ni se duplican.

## Migración y rollback

La migración es `prisma/migrations/202607230001_recommendation_analysis_runs/migration.sql`.

Se validó desde cero en PostgreSQL 16 y después se aplicó en Supabase. Las tablas nuevas revocan
acceso directo a `anon` y `authenticated`.

En producción se prefiere **forward-fix**. Un rollback destructivo solo es viable si las tablas están
vacías: primero se elimina la tabla de enlaces, luego la tabla de corridas y finalmente sus enums.
El valor agregado a `InAppNotificationType` no debe intentar eliminarse con SQL improvisado porque
PostgreSQL no soporta quitar valores enum de forma segura sin reconstruir el tipo.

## Evidencia de validación

Corte local vigente: 2026-08-12. Las cifras menores en documentos fechados son históricas.

| Capa | Resultado |
|---|---|
| Backend unitario | 99 archivos, 386 pruebas y 10 omitidas |
| IA offline | 2 archivos, 24 escenarios |
| PostgreSQL aislado | Claim, tenant, estados, cancelación, reintento y enlaces aprobados |
| Frontend | ESLint y build aprobados |
| E2E dedicado | Admin, rol de lectura y cambio de tenant aprobados |
| E2E integral | Login, tenants, análisis, inventario, recomendación y ejecución aprobados |
| Smoke HTTP real | `POST /analysis-runs` respondió `202` en 48 ms contra PostgreSQL aislado |
| Supabase | Migración aplicada; tablas, índices y grants verificados |
| OCI real | No ejecutado para esta fase |
| AWS real | Bloqueado por ausencia de cuenta/rol |
| LLM real | Canary opcional no ejecutado |
