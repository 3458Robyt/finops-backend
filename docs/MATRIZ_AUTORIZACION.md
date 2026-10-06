# Matriz de autorización FinOps

> Fuente autoritativa de capacidades: `src/domain/security/AuthorizationPolicy.ts`.
> Última verificación: 2026-09-04.

## Principios

- El backend decide la autorización; ocultar o deshabilitar controles en el frontend solo mejora la experiencia.
- Toda operación conserva el aislamiento por `tenantId` y, cuando aplica, RLS en PostgreSQL.
- `MASTER_ADMIN` puede administrar tenants, pero debe seleccionar un tenant válido para operar sobre datos FinOps.
- `CLIENT_APPROVER` puede decidir recomendaciones y validar mediciones, pero no ejecutar cambios ni crear mediciones.
- `CLIENT_VIEWER` y `VIEWER` son de solo lectura.
- Los workers usan un contexto de base de datos explícito y no representan permisos interactivos de un usuario.

## Capacidades por rol

| Capacidad | MASTER_ADMIN | OPERATOR_ADMIN | LEAD_TECHNICIAN | ADMIN | FINOPS_TECHNICIAN | CLIENT_APPROVER | CLIENT_VIEWER | VIEWER |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Lectura FinOps | Sí | Sí | Sí | Sí | Sí | Sí | Sí | Sí |
| Administrar tenants y asignaciones | Sí | — | — | — | — | — | — | — |
| Administrar conexiones cloud | Sí | Sí | Sí | Sí | Sí | — | — | — |
| Administrar ingesta | Sí | Sí | Sí | Sí | Sí | — | — | — |
| Observar trazas técnicas del agente | Sí | Sí | Sí | Sí | Sí | — | — | — |
| Configurar agente y reglas | Sí | Sí | Sí | Sí | — | — | — | — |
| Generar recomendaciones/análisis | Sí | Sí | Sí | Sí | Sí | — | — | — |
| Aprobar o rechazar recomendaciones | Sí | Sí | Sí | Sí | Sí | Sí | — | — |
| Generar planes y registrar ejecución | Sí | Sí | Sí | Sí | Sí | — | — | — |
| Crear mediciones de ahorro | Sí | Sí | Sí | Sí | Sí | — | — | — |
| Verificar o rechazar mediciones | Sí | Sí | Sí | Sí | Sí | Sí | — | — |
| Administrar presupuestos | Sí | Sí | Sí | Sí | Sí | — | — | — |
| Administrar asignación y cierres | Sí | Sí | Sí | Sí | Sí | — | — | — |
| Conciliar valor realizado | Sí | Sí | Sí | Sí | Sí | — | — | — |
| Gestionar correo y Telegram | Sí | Sí | — | Sí | — | — | — | — |
| Cuenta privilegiada/MFA | Sí | Sí | Sí | Sí | — | — | — | — |

## Identificadores de permiso

| Permiso | Uso |
|---|---|
| `FINOPS_READ` | Consultas tenant-scoped de costos, inventario, métricas y analítica. |
| `TENANT_MANAGE` | Administración MSP de tenants, usuarios operativos y asignaciones. |
| `CLOUD_MANAGE` | Conexiones, credenciales y configuración cloud. |
| `INGESTION_MANAGE` | Validación, ingesta, backfill y reconciliación. |
| `AGENT_OBSERVE` | Trazas y contexto técnico del agente. |
| `AGENT_CONFIGURE` | Perfiles, reglas y canales gobernados del agente. |
| `RECOMMENDATION_GENERATE` | Corridas de análisis y generación gobernada. |
| `RECOMMENDATION_DECIDE` | Aprobación o rechazo de recomendaciones. |
| `RECOMMENDATION_EXECUTE` | Planes y registro de ejecución manual. |
| `SAVINGS_MEASURE` | Creación de mediciones posteriores a ejecución. |
| `SAVINGS_VERIFY` | Verificación o rechazo humano de mediciones. |
| `BUDGET_MANAGE` | Creación, edición, evaluación y eliminación de presupuestos. |
| `COST_ALLOCATION_MANAGE` | Reglas, activación y cierres de asignación. |
| `VALUE_RECONCILE` | Conciliación manual del valor realizado. |
| `OUTBOUND_MANAGE` | Vínculos Telegram y mensajes externos. |
| `PRIVILEGED_ACCOUNT` | Aplicación de controles reforzados de MFA y elegibilidad operativa. |

## Defensa en profundidad

La política central se aplica en dos niveles cuando la operación lo requiere:

1. **Rutas:** middleware `requireRole(rolesForPermission(...))` para cloud, ingesta, IA y conciliación.
2. **Aplicación/dominio:** `requirePermission(...)` o `hasPermission(...)` antes de escribir presupuestos,
   asignación, mensajería, configuración del agente, recomendaciones y administración MSP.

Las guardas de recomendaciones usan permisos distintos para ejecución, decisión, creación de mediciones y
verificación de mediciones. Esto evita que un aprobador del cliente pueda registrar una ejecución o calcular
un ahorro por sí mismo.

## Reglas adicionales que no son permisos del actor

- El módulo maestro crea usuarios `OPERATOR_ADMIN`, `LEAD_TECHNICIAN` o `FINOPS_TECHNICIAN`.
- `LEAD_TECHNICIAN` conserva la operación FinOps y puede configurar el agente, pero no administra tenants ni canales de salida.
- Una asignación de tenant solo acepta usuarios operativos privilegiados existentes.
- Las reglas anteriores validan el objeto administrado; no sustituyen `TENANT_MANAGE` para el actor.
- Los IDs de tenant, conexión, recurso, recomendación y plan se validan nuevamente en repositorios tenant-aware.

## Verificación

- `src/domain/security/AuthorizationPolicy.test.ts` contiene una matriz exhaustiva y falla si un rol cambia
  silenciosamente de capacidad.
- Las pruebas de servicios cubren denegación para viewers en presupuestos, asignación, análisis y Telegram.
- Las pruebas del controlador de recomendaciones cubren decisión permitida para `CLIENT_APPROVER` y denegada
  para `VIEWER`.
- El canary runtime RLS verifica aislamiento con dos tenants incluso si una guarda de aplicación falla.

Al agregar una operación sensible se debe:

1. reutilizar un permiso existente o añadir uno con semántica única;
2. actualizar la matriz exhaustiva;
3. aplicar autorización en backend;
4. añadir prueba permitida y denegada;
5. actualizar este documento.
