# Runbook de respaldo y recuperación

Fecha de revisión: 2026-08-12.

Este runbook define la operación mínima para proteger y recuperar la base de
datos de FinOps. No sustituye la política de backups administrados de Supabase
ni autoriza operaciones destructivas contra la base principal. Los comandos de
restauración siempre deben apuntar primero a una base o proyecto aislado.

## 1. Backup

1. Confirmar ventana, responsable, destino cifrado y retención aprobada.
2. Obtener la cadena de conexión desde el secret manager o el entorno seguro;
   nunca pasar la contraseña en la línea de comandos ni guardarla en Git.
3. Generar un dump custom fuera del repositorio:

```powershell
pg_dump --format=custom --no-owner --no-acl --file=finops-<utc>.dump "$env:DATABASE_URL"
```

4. Calcular un hash del artefacto, subirlo al almacenamiento cifrado y registrar
   fecha, versión de aplicación, última migración y tamaño.
5. Verificar que el backup pueda leerse antes de marcarlo como válido:

```powershell
pg_restore --list finops-<utc>.dump | Select-Object -First 20
```

El proveedor administrado debe mantener además PITR y retención según el
entorno. Los dumps manuales son una segunda capa, no una sustitución de PITR.

## 2. Restore aislado y migraciones

1. Crear una base de restauración con acceso restringido y sin tráfico de
   usuarios.
2. Restaurar sin propietarios ni ACL heredadas:

```powershell
pg_restore --clean --if-exists --no-owner --no-acl --dbname="$env:RESTORE_DATABASE_URL" finops-<utc>.dump
```

3. Comprobar tablas críticas, conteos acotados, RLS, políticas, funciones y
   roles. No copiar datos restaurados a la base principal como parte de esta
   prueba.
4. Ejecutar `npx prisma migrate status` y verificar que la migración esperada
   de `DB_EXPECTED_MIGRATION` esté aplicada.
5. Probar login, cambio de tenant, lectura de costos, lectura de métricas,
   recomendación y consulta de trazabilidad con fixtures de prueba.
6. Registrar resultado, duración, hash del dump y diferencias encontradas.

Las migraciones Prisma se aplican hacia adelante con `npx prisma migrate deploy`.
No se hace rollback destructivo de esquema: si una versión falla, se revierte la
aplicación a una versión compatible y se crea una migración correctiva revisada.
`prisma migrate resolve` solo se usa después de verificar el estado real de la
base y documentar la decisión.

## 3. Rotación de credenciales

- Rotar secretos del proveedor IA, SMTP, Telegram, JWT y base de datos fuera del
  repositorio.
- Para credenciales cloud cifradas, desplegar la nueva
  `CREDENTIAL_ENCRYPTION_KEY` con su `CREDENTIAL_KEY_VERSION`, ejecutar el
  procedimiento de re-encriptación controlada y conservar la clave anterior
  únicamente durante la ventana de transición aprobada.
- Revocar la clave anterior y comprobar que no aparece en logs, dumps públicos,
  variables exportadas ni artefactos de CI.
- Invalidar sesiones cuando la rotación afecte identidad o seguridad de usuario.

## 4. Pérdida de worker o job abandonado

1. Revisar `runtime_process_heartbeats`; un proceso `RUNNING` que supere
   `PROCESS_HEARTBEAT_STALE_AFTER_MS` se considera atrasado, no exitoso.
2. Revisar jobs `RUNNING`, `PROCESSING` o equivalentes con lease vencido.
3. No borrar trazabilidad. El siguiente worker puede recuperar el trabajo cuando
   su consulta de claim detecte el lease vencido mediante `FOR UPDATE SKIP
   LOCKED`.
4. Confirmar idempotencia por job/ventana antes de reintentar; si la causa es
   externa, conservar el error sanitizado y aplicar el backoff configurado.
5. Si el proceso vuelve, comprobar heartbeat, logs de claim/lease y que no haya
   dos ejecuciones activas de la misma unidad de trabajo.

## 5. Rollback de runtime RLS

El rollback normal es de aplicación, no de permisos. Ante una incidencia:

1. Retirar tráfico con `/ready` sin desactivar RLS.
2. Detener workers/schedulers afectados y conservar evidencia de diagnóstico.
3. Volver a una imagen compatible con el esquema actual o aplicar una migración
   correctiva revisada.
4. Verificar `DB_RUNTIME_ENFORCE=true`, `DB_RUNTIME_ROLE=finops_runtime`,
   `DB_EXPECTED_MIGRATION` y el canary de aislamiento antes de reabrir tráfico.
5. No ejecutar `DISABLE ROW LEVEL SECURITY`, no conceder tablas a roles API y
   no usar `postgres` como runtime de la aplicación para acelerar la recuperación.

## 6. Rehearsal pendiente

La documentación y los comandos están preparados. La prueba formal de backup,
restore aislado y medición RTO/RPO debe ejecutarse cuando exista el destino de
despliegue y el canal de backup autorizado. Hasta entonces `OPS-006` permanece
abierto/diferido; no se presenta este runbook como evidencia de una restauración
productiva ya realizada.
