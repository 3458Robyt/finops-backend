# Matriz de amenazas y controles de autenticación

Fecha de revisión: 2026-08-11
Alcance: `finops-backend` y `finops-app` de FinOps Inteligente.

Este documento es la referencia operativa para revisar el ciclo de identidad.
No sustituye la configuración del proveedor de despliegue ni una prueba de
penetración externa.

La asignación de capacidades a roles y sus puntos de enforcement se documentan
por separado en `docs/MATRIZ_AUTORIZACION.md`.

## Principios

1. El JWT de acceso es corto y solo vive en memoria del navegador.
2. La renovación es un token opaco, aleatorio, de un solo uso, guardado como
   hash en PostgreSQL y entregado únicamente en cookie `HttpOnly`.
3. La sesión persistida y el tenant activo se validan en cada request protegido.
4. Las credenciales de proveedores cloud nunca entran al prompt ni a los logs.
5. Los endpoints que dependen de la cookie de renovación validan el `Origin`
   contra `CORS_ORIGIN` cuando el navegador lo envía.
6. El rol `finops_runtime` es el único rol de aplicación y las tablas de
   credenciales tienen RLS propio.

## Matriz de amenazas

| Amenaza | Superficie | Control implementado | Evidencia / prueba | Residual |
|---|---|---|---|---|
| Robo de JWT de acceso | API y navegador | JWT corto, memoria de módulo, sesión persistida, revocación | `AuthService.test.ts`, middleware de auth, build frontend | Una sesión activa sigue válida hasta expiración o revocación |
| Robo de refresh token | Cookie de renovación | Cookie `HttpOnly`, `Secure` en producción, `SameSite`, hash SHA-256 en BD, rotación one-use | `AuthRefreshService`, migraciones auth lifecycle | Requiere TLS y protección del navegador/host |
| Replay de refresh token | `/auth/refresh` | Claim atómico; replay revoca familia completa | `PrismaAuthSecurityRepository.rotateRefreshToken` | Debe observarse y alertarse en producción |
| CSRF sobre refresh/logout/cambio de tenant | Endpoints con cookie | `trustedOrigin` + CORS explícito + `SameSite` | `trustedOrigin.test.ts` | Clientes sin `Origin` son permitidos; protegerlos con TLS y no exponer cookie fuera del navegador |
| Enumeración de cuentas | Recuperación de contraseña | Respuesta genérica y mismo código HTTP para correos existentes/desconocidos | `PasswordRecoveryService.test.ts` | Timing no es perfectamente constante |
| Abuso de recuperación | `/auth/password-reset/*` | Token aleatorio, hash persistido, TTL 5–60 min, consumo atómico, política fuerte de contraseña, revocación de sesiones | servicio y repositorio Prisma | Email/SMTP debe estar correctamente protegido |
| Compromiso de cuenta privilegiada | Login de administradores | TOTP MFA obligatorio en producción, códigos de recuperación de un solo uso y enrolamiento previo al primer acceso | `MfaService`, `MfaRecoveryCode`, RFC 6238/recovery tests, `MFA_REQUIRED_FOR_PRIVILEGED=true` | Custodia segura de los códigos en texto plano corresponde al usuario; solo se muestran al generarlos |
| Reutilización de código TOTP | `/auth/mfa/*` | `lastUsedStep` atómico y challenge de un solo uso/TTL | `PrismaMfaRepository.consumeChallenge` | Dependencia de sincronización temporal razonable |
| Lectura cross-tenant | PostgreSQL y API | `finops_runtime`, contexto de sesión, RLS tenant-aware, RLS específico de tablas auth | migraciones `202607280001`, `202608110001`–`005`, canary RLS | Activación productiva debe mantenerse obligatoria |
| Inyección de secretos en logs | errores, auditoría y SDK | `safeErrorMessage`, redacción de JWT/API keys/PEM/URLs con credenciales | pruebas de safe errors | Un logger externo debe aplicar redacción adicional |
| CORS demasiado permisivo | API | Orígenes explícitos, sin wildcard/rutas/credenciales, validación productiva | `runtimeConfig.test.ts` | Revisar allowlist por ambiente |
| Fuerza bruta | login, MFA, recuperación, IA | Rate limits separados y bounded in-memory | middleware tests | Store distribuido pendiente de despliegue horizontal |
| CSRF vía XSS | frontend | No almacenar tokens en Web Storage, CSP/Helmet base, sanitización React | revisión de transporte y build | Requiere CSP final, SAST y pruebas de seguridad de frontend |

## Contrato de configuración productiva

Variables obligatorias relacionadas con identidad:

```dotenv
JWT_SECRET=<secreto aleatorio de al menos 32 caracteres>
CREDENTIAL_ENCRYPTION_KEY=<base64 de 32 bytes>
DB_RUNTIME_ENFORCE=true
DB_RUNTIME_ROLE=finops_runtime
MFA_REQUIRED_FOR_PRIVILEGED=true
AUTH_REFRESH_TOKEN_TTL_SECONDS=2592000
AUTH_COOKIE_SAME_SITE=lax
PASSWORD_RESET_TTL_SECONDS=900
PASSWORD_RESET_URL=https://app.example.com/reset-password
CORS_ORIGIN=https://app.example.com
```

Las claves deben venir de un secret manager del destino. `.env` se admite solo
para desarrollo local y nunca debe versionarse.

## Acciones pendientes antes de producción

- revisar periódicamente el número de códigos MFA disponibles y regenerarlos con
  un TOTP vigente; cada regeneración revoca atómicamente los anteriores;
- migrar rate limiting a Redis/servicio equivalente si hay más de una instancia;
- activar agregador de logs, alertas para replay MFA/refresh y métricas de fallos;
- ejecutar SAST, DAST, dependencia completa y prueba de penetración externa;
- revisar periódicamente roles, asignaciones de tenant y sesiones activas.
