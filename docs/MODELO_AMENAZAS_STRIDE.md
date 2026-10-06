# Modelo de amenazas STRIDE — FinOps Inteligente

Fecha de revisión: 2026-08-12
Alcance: backend, frontend, PostgreSQL/Supabase, proveedores cloud, IA y mensajería.

> **Documento histórico.** La matriz fue revisada el 2026-08-12. No sustituye el estado autoritativo
> de 2026-09-22 13:15 UTC en `docs/ESTADO_ACTUAL_FINOPS.md` y `docs/DEUDA_TECNICA.md`. Las referencias a
> OCI Usage API bloqueada describen ese corte; el canary vigente la confirma operativa como
> redundancia, mientras AWS real continúa bloqueado por falta de cuenta/rol.

Este documento complementa `MATRIZ_SEGURIDAD_AUTENTICACION.md` y `MATRIZ_AUTORIZACION.md`.
Describe el riesgo residual de la beta consolidada; no sustituye un análisis de penetración
externo ni la configuración de seguridad del proveedor de despliegue.

## Activos y límites de confianza

| Activo | Límite que debe protegerse | Fuente de verdad |
|---|---|---|
| Sesiones, refresh tokens y MFA | Navegador ↔ API ↔ PostgreSQL | Sesión persistida, JWT y RLS |
| Costos, métricas e inventario | Tenant ↔ API ↔ runtime PostgreSQL | `tenantId`, `cloudResourceId` y RLS |
| Credenciales OCI/AWS | Usuario operador ↔ API ↔ proveedor cloud | `CredentialCipher` y políticas read-only |
| Recomendaciones y planes | Evidencia determinística ↔ LLM ↔ auditor ↔ decisión humana | Snapshots, hashes, auditoría y estados |
| Mensajería | API ↔ SMTP/Telegram | Configuración, secreto de webhook y deduplicación |
| Jobs y workers | Scheduler ↔ PostgreSQL ↔ proveedor | Leases, locks, reintentos e idempotencia |

## Matriz STRIDE

| Categoría | Superficie / abuso | Controles implementados | Evidencia | Riesgo residual / siguiente acción |
|---|---|---|---|---|
| **S — Suplantación** | Reutilizar un JWT, refresh token, sesión revocada o tenant anterior | Validación de firma, issuer, audience, expiración, sesión persistida, usuario activo, tenant y rol; refresh opaco con hash, rotación y revocación de familia | `AuthService`, `AuthRefreshService`, canary RLS y pruebas de ciclo de vida | Activar alertas de replay y ejecutar DAST antes de producción pública |
| **S — Suplantación** | Invocar el webhook de Telegram como si fuera Telegram | Secreto opcionalmente obligatorio cuando el canal está habilitado, comparación constante, rate limit e idempotencia de interacción | `TelegramController`, `safeSecretCompare`, pruebas Telegram | La configuración del despliegue debe rechazar Telegram habilitado sin secreto |
| **S — Suplantación** | Usar una credencial cloud de otro tenant | Credenciales cifradas por conexión; búsquedas con `tenantId`; proveedor recibe únicamente el payload de la conexión autorizada | `PrismaCloudCredentialRepository`, onboarding y RLS | Rotación formal de claves/cuentas queda en runbook de despliegue |
| **T — Manipulación** | Cambiar una decisión, plan, cierre o medición de otro tenant | Autorización central, filtros tenant-aware, RLS, transacciones, estados e invariantes de inmutabilidad | `MATRIZ_AUTORIZACION.md`, cierres compartidos, canary RLS | Mantener pruebas IDOR en cada nuevo endpoint |
| **T — Manipulación** | Inyectar nombres, tags o instrucciones en el contexto del LLM | Contexto mínimo construido por el backend; evidencia canónica; parser/schema; compuertas determinísticas; auditor independiente; sin tools ejecutables | `TESTING_AUDITORIA_IA.md`, golden scenarios 21/21 | Ampliar red-team de prompt injection cuando se cambie el proveedor |
| **T — Manipulación** | Duplicar o alterar un job de ingesta | Ventanas persistentes, idempotencia, `FOR UPDATE SKIP LOCKED`, leases y reintentos acotados; deduplicación por hash | pruebas de scheduler/worker y repositorio de ingesta | Ejecutar pruebas de recuperación con worker interrumpido en entorno aislado |
| **R — Repudio** | Negar quién aprobó, ejecutó o modificó una optimización | Decisiones, auditoría de cambios, trazas IA, planes versionados, ejecución manual y medición de ahorro con actor/fecha | timeline de recomendación, trazabilidad y Value Realization | Centralizar logs durables y retención cuando exista despliegue |
| **R — Repudio** | Negar una operación administrativa o cambio de acceso tenant | Auditoría de administración MSP, asignaciones tenant-aware y sesiones revocables | `MasterAdminController`, `MATRIZ_AUTORIZACION.md` | Añadir exportación/retención de auditoría en el runbook productivo |
| **I — Divulgación** | Leer costos, métricas, recomendaciones o credenciales cross-tenant | JWT tenant-aware, política de aplicación, RLS con `finops_runtime`, credenciales nunca retornadas | canary RLS de dos tenants, pruebas de autorización | La activación obligatoria de RLS depende del entorno desplegado |
| **I — Divulgación** | Enviar secretos, IDs sensibles o datos de otro cliente al LLM | Snapshot filtrado, aislamiento por tenant/recurso, no inclusión de credenciales, auditoría de evidencia y límites de contexto | `FinOpsAiService`, `FinOpsArtifactAiRunner`, canary IA aislado | Revisar prompts y snapshots cada vez que se agregue un campo |
| **I — Divulgación** | Escribir JWT, API key, PEM, URL autenticada, contraseña, bearer token o cookie en logs, trazas o campos operativos durables | `safeErrorMessage` en logs, respuestas HTTP, trazas IA, aprendizaje, ingesta, contexto, Telegram e inventario OCI; eventos estructurados y `diagnosticId` sin status interno | regresiones de headers/cookies y de persistencia de errores; datasource IDE fuera de Git | Agregador externo debe conservar redacción y controles de acceso |
| **I — Divulgación** | Exponer configuración SMTP/Telegram en API o UI | Clientes outbound solo devuelven resultado; secretos entran por configuración; webhook no devuelve payload sensible | `EmailClient`, `TelegramClient`, rutas outbound | Secret manager externo y rotación quedan diferidos hasta definir destino |
| **D — Denegación de servicio** | Fuerza bruta en login, MFA, recuperación, IA o webhook | Rate limits por superficie, límites de body/query, timeouts externos, bounded retries y mensajes no bloqueantes | middleware de rate limit y pruebas de configuración | Migrar a store compartido antes de escalar horizontalmente |
| **D — Denegación de servicio** | Acumular jobs o bloquear el backend con una ingesta/LLM lento | Workers separados, leases, no solapamiento, timeout del proveedor, procesamiento en background y shutdown con drenaje | `OPERACION_PRODUCCION.md`, pruebas de loops y aprendizaje | Alertar backlog/leases en observabilidad productiva |
| **E — Elevación** | Un `VIEWER` ejecuta ingesta, IA, decisión, ejecución o administración | `AuthorizationPolicy` central con ocho roles y dieciséis capacidades; rutas y servicios aplican la misma política | suite de autorización y matriz vigente | Toda capacidad nueva debe incorporarse a la matriz y prueba de roles |
| **E — Elevación** | Usar acceso de API/Supabase para saltar el runtime RLS | Grants restringidos, helpers `SECURITY DEFINER` acotados, rol `finops_runtime` y políticas tenant-aware | migraciones de hardening y canary runtime RLS | Mantener `DB_RUNTIME_ENFORCE=true` y verificar `/ready` en producción |
| **E — Elevación** | Convertir una recomendación en remediación automática | Acciones cloud manuales, planes auditados, aprobación humana y ausencia de shell/SQL/tools del LLM | contratos de planes y auditor IA | No añadir automatización cloud sin una decisión explícita de alcance |

## Controles de release

Antes de publicar una versión deben ejecutarse, como mínimo:

1. `npm run test:all` del backend.
2. `npm run typecheck`, `npm run lint` y `npm run build` del frontend.
3. `npm audit --omit=dev --audit-level=high` en ambos repositorios.
4. Canary de autorización/RLS, IA offline y, cuando corresponda, canary OCI read-only.
5. Revisión de secretos rastreados, migraciones y cambios de permisos.
6. Verificación de que AWS permanece `BLOQUEADO / STANDBY` si no existe cuenta y rol reales.

## Riesgos fuera del alcance actual

- AWS productivo: bloqueado por falta de cuenta/rol real; no se cierra con mocks.
- OCI Usage API: en el corte de este documento estaba bloqueada hasta aplicar la policy read-only;
  el corte autoritativo 2026-09-22 13:15 UTC la valida operativa como redundancia y mantiene FOCUS
  condicionado a una ubicación exacta.
- Rate limiting distribuido, secret manager y observabilidad 24/7: diferidos hasta existir un destino de despliegue.
- Prueba de penetración externa, DAST y restore productivo: requieren infraestructura y ventana autorizada.
