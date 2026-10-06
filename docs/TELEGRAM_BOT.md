# Telegram Bot FinOps

## Modelo operativo

- Existe un único bot global de FinOps, configurado una sola vez en el backend.
- Solo se aceptan chats privados. Los grupos, canales y mensajes sin texto se ignoran y quedan registrados.
- El webhook únicamente valida el secreto y persiste el `update_id`; responde `202` sin esperar a IA ni a Telegram.
- El worker `telegram-inbound` procesa la cola con lease, idempotencia y reintentos acotados.
- Las respuestas usan el mismo motor IA y los mismos datos tenant-scoped del portal, siempre en español.
- Telegram es un canal de consulta. Aprobar, rechazar o ejecutar una recomendación siempre abre el portal web.

## Flujo de acceso

### Técnicos multi-tenant

1. El técnico inicia sesión en el portal y genera un código de auto-vinculación desde `Perfil`.
2. Envía `/start <código>` al bot antes de que expire (10 minutos).
3. El bot consume el código una sola vez y vincula un único chat privado a su usuario FinOps.
4. `/tenants` lista el tenant principal y los tenants activos asignados al técnico.
5. `/tenant <número, slug o nombre>` cambia el tenant activo del chat. Las consultas siguientes usan ese tenant.

El enlace de Telegram es global por usuario: cambiar de tenant no crea otro usuario, contraseña ni chat.

### Administrador maestro

`MASTER_ADMIN` puede consultar y seleccionar cualquier tenant activo, igual que en el selector de tenant del portal; no necesita una asignación individual por tenant. `/tenants` muestra el catálogo activo y `/tenant <número, slug o nombre>` cambia el contexto para las consultas siguientes.

### Clientes finales

El cliente también puede auto-vincular su chat desde `Perfil`, pero queda limitado al tenant principal. No puede
cambiar el tenant desde Telegram ni consultar información de otro tenant.

### Respaldo administrativo

Un usuario con `OUTBOUND_MANAGE` (`MASTER_ADMIN`, `OPERATOR_ADMIN` o `ADMIN`) puede registrar manualmente un chat
privado desde la gestión de Telegram. El chat debe pertenecer al usuario indicado, el vínculo queda auditado y solo
puede existir un vínculo activo por usuario y por `chat_id`.

## Variables

```env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=token_entregado_por_botfather
TELEGRAM_WEBHOOK_SECRET=secreto_largo_aleatorio
TELEGRAM_BOT_USERNAME=nombre_del_bot_sin_arroba
OUTBOUND_PROVIDER_TIMEOUT_MS=15000
TELEGRAM_INBOUND_WORKER_ENABLED=true
TELEGRAM_INBOUND_WORKER_ID=telegram-inbound-01
TELEGRAM_INBOUND_WORKER_INTERVAL_MS=1000
TELEGRAM_INBOUND_WORKER_LEASE_MS=120000
TELEGRAM_INBOUND_WORKER_RETRY_BACKOFF_MS=5000
```

El secreto del webhook debe ser distinto del token del bot. La integración se rechaza en runtime si está habilitada
sin token o secreto. El timeout aplica a las llamadas salientes; la cola evita que el webhook quede bloqueado.

## Configurar el webhook

El backend necesita una URL pública HTTPS. En desarrollo puede usarse un túnel temporal como ngrok.

```powershell
npm run telegram:set-webhook -- --url https://<backend-public-url>/api/v1/telegram/webhook
```

Telegram enviará `X-Telegram-Bot-Api-Secret-Token`. El endpoint comprueba ese header, guarda el update de forma
idempotente por `update_id` y devuelve `202 Accepted`. Si el mismo update llega otra vez no se duplica.

## Comandos

- `/start`: muestra el estado del vínculo o instrucciones para vincularse.
- `/ayuda`: lista comandos disponibles.
- `/chat <pregunta>`: consulta al asistente IA.
- Texto libre: se trata como pregunta al asistente IA.
- `/recordatorios`: muestra ahorro no capturado.
- `/recomendaciones`: lista recomendaciones activas.
- `/costos`: muestra el resumen de costos actual.
- `/oportunidades`: muestra oportunidades detectadas.
- `/tenants`: muestra el tenant principal y asignaciones activas del técnico; para `MASTER_ADMIN`, todos los tenants activos; para clientes, solo el tenant principal.
- `/tenant <número, slug o nombre>`: cambia el tenant activo dentro del alcance permitido del usuario.

Las acciones de gobierno no se ejecutan desde Telegram. El usuario debe abrir el enlace del portal para revisar y
aprobar o rechazar una recomendación con trazabilidad.

## Estado y trazabilidad

- `telegram_inbound_updates`: cola durable, deduplicación, intentos, lease y error sanitizado.
- `telegram_interaction_logs`: comando, resultado, tenant efectivo y vista previa acotada.
- `telegram_chat_links`: vínculo global del usuario, tenant de origen y tenant activo seleccionado.
- `audit_events`: auto-vinculación, creación/desactivación de vínculos y acciones administrativas.

Las entregas salientes se guardan en `outbound_message_deliveries` como `PENDING`, `SENT`, `FAILED` o `SKIPPED` y
las drena el scheduler de mensajes. Telegram respeta el límite del proveedor, reintenta fallos acotados y no
expone errores crudos al usuario.

Un administrador puede ejecutar la verificación del bot desde `Mensajería`; usa `getMe` y no envía mensajes. Las
pruebas de entrega se encolan y se inspeccionan en el historial.

## Seguridad

- Los chats no vinculados nunca reciben datos FinOps.
- Solo se aceptan mensajes de chats privados.
- El bot no recibe ni almacena contraseñas, JWT, claves cloud ni secretos del portal.
- El código de auto-vinculación se almacena únicamente como hash, expira y se consume atómicamente.
- El `chat_id` no es una credencial; las vinculaciones administrativas exigen sesión, permiso y auditoría.
- Los errores se registran con `safeErrorMessage`; no se guardan tokens ni PEM en logs.

## Canary real controlado

El canary no usa datos de tenants. Para emitir un mensaje real hay que confirmar explícitamente el destino:

```powershell
$env:MESSAGING_CANARY_CONFIRM='I_UNDERSTAND_THIS_SENDS_A_REAL_MESSAGE'
$env:MESSAGING_CANARY_TELEGRAM_CHAT_ID='<chat-id-de-prueba>'
# o: $env:MESSAGING_CANARY_EMAIL_TO='correo-de-prueba@example.com'
npm run test:canary:messaging
```

Un `PASSED` valida conectividad del proveedor, pero la cola durable debe verificarse además desde `Mensajería` y
los registros de entregas. Las respuestas IA del worker deben ejecutarse con contexto de tenant/usuario para
cumplir RLS en las trazas de `ai_context_traces`; los fallos persistentes deben terminar con un aviso genérico,
no con silencio ni errores internos expuestos.

## Incidente multi-tenant y chat IA — 2026-10-05

El repositorio de opciones de tenant aplica la misma autorización que el portal: `MASTER_ADMIN` ve todos los
tenants activos, mientras los demás roles quedan limitados al tenant principal y sus asignaciones activas.
El worker establece el contexto del vínculo y del tenant seleccionado antes de llamar al asistente, de modo que
las trazas respeten RLS. Tras agotar reintentos, el usuario recibe un mensaje genérico en español. En beta, el
hotfix está desplegado en `api` y `notification-scheduler`; la validación conversacional final debe hacerse con
un chat autorizado usando `/tenants`, `/tenant tak-2-0` y luego `/chat <pregunta>`.

El asistente también reconoce meses calendario en español (por ejemplo, “septiembre” o “septiembre de 2026”) y pide al repositorio el snapshot exacto de ese mes. Si se omite el año, lo infiere desde el último período observado. No debe usar el snapshot más reciente como sustituto de un mes solicitado sin datos.

### Nota operativa de beta

El frontend Nginx usa resolución DNS dinámica para el upstream Docker `api:3000` (beta image `finops-beta-frontend:proxy-dns-35e8126`). Si se recrea la API, Nginx actualiza su dirección sin reiniciar el frontend. Tras un 502, revisar primero `/health`, `getWebhookInfo` (`pending_update_count` y fecha del último error) y los logs del frontend/API; el último error de Telegram puede seguir visible como histórico aunque el webhook ya esté recuperado.
