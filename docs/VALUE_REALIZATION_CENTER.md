# Centro de Realización de Valor FinOps

> Esta guía describe el flujo funcional. Los resultados económicos solo deben
> presentarse como verificados cuando exista una medición posterior comparable y
> aprobada por una persona autorizada.

## Propósito

El Centro de Realización de Valor conecta cada oportunidad con su ciclo operativo: estimación, decisión, ejecución manual, medición posterior y verificación humana. Responde cuánto valor se esperaba, cuánto se observó y cuánto fue validado, sin presentar una declaración manual como ahorro comprobado.

## Fuente de verdad

`recommendation_savings_measurements` es la única fuente de verdad para el ahorro observado, proyectado y verificado. El centro no crea un ledger alternativo. Las recomendaciones sin ejecución se muestran como pendientes y el valor reportado en `recommendation_manual_executions` se conserva separado de los importes verificados.

Los cálculos son determinísticos y se ejecutan mediante `createSavingsMeasurement`, usando costos/FOCUS y evidencia técnica disponible. La IA no participa en sumas, tasas, monedas, variaciones ni verificación. Las mediciones verificadas por una persona no se modifican desde la conciliación.

## API

Todas las rutas se montan bajo `/api/v1/value-realization` y usan el `tenantId` del JWT activo.

| Método | Ruta | Permiso | Uso |
|---|---|---|---|
| GET | `/summary` | Cualquier rol autenticado | KPIs por moneda y conteos del ciclo |
| GET | `/items` | Cualquier rol autenticado | Portafolio paginado y filtrable |
| GET | `/trend` | Cualquier rol autenticado | Serie mensual de verificado y aumentos |
| GET | `/export.csv` | Cualquier rol autenticado | Exportación acotada a 10.000 filas |
| POST | `/reconcile` | `ADMIN`, `MASTER_ADMIN`, `OPERATOR_ADMIN`, `FINOPS_TECHNICIAN` | Recalcula candidatos pendientes |

Filtros: `status`, `currency`, `provider`, `cloudAccountId`, `serviceName`, `resourceId`, `severity`, `search`, `onlyIncreases`, `onlyPending`, fechas de ejecución/verificación, `pageSize` y `cursor`.

El resumen devuelve una fila por moneda. No se suman USD, COP u otras monedas. Los aumentos de costo se mantienen en `costIncreaseMonthlyAmount` y no se restan silenciosamente del ahorro verificado.

## Conciliación

La conciliación selecciona como máximo el lote solicitado de ejecuciones `EXECUTED` o `PARTIAL` que aún no tienen medición verificada. Reutiliza el hash de evidencia y la restricción existente de mediciones para evitar duplicados. Una corrida informa `created`, `unchanged`, `waitingForData`, `calculated`, `insufficientEvidence` y `failures`; un candidato fallido no interrumpe el resto.

Puede ejecutarse manualmente con `POST /reconcile` o después de una ingesta exitosa cuando `SAVINGS_RECONCILIATION_ENABLED=true`. El lote por defecto es 50 y puede ajustarse con `SAVINGS_RECONCILIATION_BATCH_SIZE`. Durante desarrollo la conciliación automática está apagada por defecto.

## Notificaciones

Las actualizaciones nuevas generan notificaciones in-app `SAVINGS_REMINDER` con metadata de `measurementId` y origen `value_realization_reconciliation`. Se reutiliza la unicidad diaria existente por tenant, usuario, recomendación, tipo y fecha para evitar duplicados. Los mensajes están en español y distinguen medición calculada, evidencia insuficiente y datos aún no disponibles.

Los canales de correo SMTP y Telegram se reutilizan de `OutboundMessageService` y permanecen apagados para este flujo salvo que `VALUE_REALIZATION_OUTBOUND_ENABLED=true`. Las entregas externas son best-effort y no bloquean ni invalidan la conciliación. El dedupe operativo usa `VALUE_REALIZATION:<measurementId>:<status>` por tenant/usuario; el callback externo solo se dispara después de crear al menos una notificación in-app nueva.

## Operación y límites

- El portafolio agrupa en PostgreSQL y devuelve como máximo 100 elementos por página.
- La exportación está limitada a 10.000 filas.
- El portafolio presenta la última ejecución por recomendación; el histórico completo sigue en el detalle y timeline.
- La conciliación considera todas las ejecuciones manuales `EXECUTED`/`PARTIAL` sin medición `VERIFIED`; que el portafolio muestre la última ejecución no oculta ejecuciones históricas pendientes.
- El aislamiento de la API usa sesión, guards y filtros tenant-scoped. Cuando el entorno exige RLS,
  el proceso debe usar el rol `finops_runtime` y superar el canary de aislamiento; esta guía no
  certifica la configuración de un despliegue particular.
- No hay conversión de monedas ni estimación de ahorro mediante LLM.

## Conciliación automática durante desarrollo

El flujo automático está desactivado por defecto. Para probarlo de forma controlada se debe configurar `SAVINGS_RECONCILIATION_ENABLED=true` junto con `SAVINGS_RECONCILIATION_TENANT_ID`. `SAVINGS_RECONCILIATION_RUN_ON_START=true` ejecuta una única corrida al iniciar y `SAVINGS_RECONCILIATION_SCHEDULER_ENABLED=true` habilita un loop no solapable con `SAVINGS_RECONCILIATION_INTERVAL_MS`. El lote está acotado por `SAVINGS_RECONCILIATION_BATCH_SIZE`; las fallas se registran y no convierten una ingesta exitosa en fallida.
