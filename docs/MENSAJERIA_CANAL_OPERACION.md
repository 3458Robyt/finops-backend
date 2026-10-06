# Mensajería por correo y Telegram

## Decisión de arquitectura

FinOps usa una cuenta SMTP institucional y un único bot global de Telegram. No se incorporan plataformas
transaccionales de terceros ni un bot por tenant. Los secretos se configuran fuera del repositorio mediante `.env`
en desarrollo y un gestor de secretos en el despliegue futuro.

## Correo SMTP

El backend usa SMTP directo, sin un servicio de envío por mensaje. Configura `EMAIL_ADDRESS` y `EMAIL_PASSWORD`; al
detectar ambos, el correo se activa automáticamente, a menos que `EMAIL_ENABLED=false` lo desactive explícitamente. Para
Gmail y Google Workspace (también con dominio propio), el transporte usa por defecto `smtp.gmail.com:587` con STARTTLS,
así que la configuración habitual solo necesita dirección y contraseña de aplicación. `SMTP_HOST` permite sobrescribir
ese valor si el administrador configuró un relay (`smtp-relay.gmail.com`) u otro proveedor; `SMTP_PORT` y `SMTP_SECURE`
solo hacen falta cuando el relay usa valores distintos.

Para Gmail y Google Workspace con autenticación por usuario, configura una contraseña de aplicación de Google en
`EMAIL_PASSWORD`, no la contraseña habitual de la cuenta. Google exige la verificación en dos pasos para crearla
([instrucciones oficiales](https://support.google.com/accounts/answer/185833)); en cuentas administradas, la política de la
organización puede ocultar o impedir esta opción. La guía oficial de [envío SMTP para Google Workspace](https://support.google.com/a/answer/176600)
indica `smtp.gmail.com` y TLS por el puerto 587. Si la contraseña de aplicación no está disponible, la
autenticación SMTP de usuario/contraseña implementada aquí no podrá conectar: no pruebes la contraseña principal; se
necesitará un mecanismo aprobado por la organización y compatible con el backend.

La autenticación SMTP actual usa usuario/contraseña. Outlook.com y Microsoft 365 requieren OAuth 2.0/Modern Auth en
sus configuraciones oficiales, por lo que no se consideran compatibles con este modo de dos variables; para esos
proveedores habría que añadir OAuth2 o utilizar un relay SMTP autorizado que acepte credenciales de aplicación.

Para beta, guarda la dirección y contraseña de aplicación en `.env.beta.runtime`, elimina cualquier `EMAIL_ENABLED=false`
explícito si quieres que las credenciales activen el canal, y recrea `api` y `notification-scheduler` para que carguen las
variables. Después, usa `Verificar SMTP` para confirmar conexión y autenticación antes de probar un envío. Las preferencias por
usuario/tenant se controlan desde `Mensajería`; habilitar el transporte no autoriza envíos indiscriminados.

El transporte Nodemailer puede usar conexiones agrupadas y límites explícitos:

- `SMTP_POOL_ENABLED=true` reutiliza conexiones.
- `SMTP_MAX_CONNECTIONS` limita la concurrencia contra el servidor SMTP.
- `SMTP_MAX_MESSAGES` rota una conexión después de cierto número de mensajes.
- `SMTP_RATE_LIMIT` limita el ritmo global de envío.
- `OUTBOUND_PROVIDER_TIMEOUT_MS` evita conexiones colgadas.

El endpoint administrativo de verificación ejecuta `transporter.verify()` sin enviar un correo. Las alertas se
encolan y el scheduler las entrega con lease, reintentos y estados auditables. Las invitaciones y recuperación de
contraseña conservan envío directo porque contienen tokens efímeros que no deben quedar en una cola durable.

## Preferencias persistentes

Cada usuario tiene una fila en `user_messaging_preferences`. Correo queda activo por defecto; Telegram queda
desactivado hasta que el usuario vincule un chat. Las categorías independientes son:

- alertas operativas;
- recomendaciones y planes;
- alertas financieras, presupuestos y ahorro;
- resúmenes ejecutivos.

El módulo `Mensajería` permite modificar estas preferencias y consultar entregas. `Perfil` conserva únicamente la
auto-vinculación de Telegram y enlaza al módulo de preferencias; no existen toggles locales que aparenten cambiar
la configuración persistente.

El diagnóstico también expone una verificación del bot mediante `getMe`. Esta operación confirma token y
conectividad sin enviar un mensaje; el envío de prueba continúa pasando por la cola durable.

## Flujo de entrega

1. Un servicio FinOps decide que existe una notificación y valida la preferencia del usuario.
2. `OutboundChannelDeliveryService` crea una entrega `PENDING` con el cuerpo y metadatos mínimos del destinatario.
3. `OutboundMessageScheduler` drena la cola global desde un worker con contexto interno.
4. `OutboundMessageDeliveryProcessor` reclama una entrega, llama a SMTP/Telegram y la marca `SENT`, `FAILED` o
   `SKIPPED` sin bloquear la operación que originó el mensaje.
5. La pantalla `Mensajería` muestra el historial reciente para diagnóstico.

Los cuerpos de correo se guardan porque son mensajes operativos. No se guardan secretos, tokens de invitación ni
contraseñas. Las respuestas largas de Telegram se recortan antes de encolarse y las respuestas del bot se
fragmentan respetando el límite del proveedor.

## Configuración de workers

En desarrollo se puede ejecutar el API y el scheduler en procesos separados. El API no debe ejecutar workers de
Telegram o mensajería cuando se quiera aislar el rendimiento del login. En un despliegue real, usar al menos un
worker de entrada Telegram y un scheduler de mensajes; ambos deben compartir la misma base de datos y el rol
runtime configurado.

## Operación segura

- No poner `SMTP_PASSWORD`, `TELEGRAM_BOT_TOKEN` ni `TELEGRAM_WEBHOOK_SECRET` en frontend, Git, tickets o logs.
- Rotar las credenciales ante cualquier exposición y revisar los logs del proveedor.
- Limitar el SMTP a una cuenta remitente dedicada y a los destinatarios necesarios.
- Usar `Mensajería > Verificar SMTP` antes de habilitar alertas.
- Ejecutar el canary real solo con una dirección/chat de prueba autorizado.
