# Canary de RLS runtime

Este canary comprueba el camino real de PostgreSQL usando el rol dedicado
`finops_runtime`. No modifica datos: únicamente lee sesiones, tenants y filas
operativas bajo distintos contextos.

## Ejecución

Desde `finops-backend`, con un `DATABASE_URL` apuntando al entorno aislado que
se quiere verificar:

```powershell
$env:DB_RUNTIME_ENFORCE = "true"
$env:DB_RUNTIME_ROLE = "finops_runtime"
npm run test:canary:runtime-rls
```

El resultado debe demostrar:

- el rol PostgreSQL activo es `finops_runtime`;
- el contexto `app.tenant_id` se aplica por consulta;
- el contexto del worker también se propaga;
- las tablas operativas se pueden consultar desde el tenant seleccionado;
- un tenant no puede ver recomendaciones de otro tenant;
- una consulta sin tenant no devuelve recomendaciones.

El canary requiere al menos dos tenants para probar aislamiento entre ellos.

## Activación controlada

1. Aplicar migraciones en el entorno aislado.
2. Ejecutar el canary anterior.
3. Ejecutar login, selector de tenant, presupuestos, asignación de costos,
   inventario, métricas, recomendaciones e ingesta.
4. Revisar logs y conteos antes de activar el enforcement en el entorno
   objetivo.
5. Activar `DB_RUNTIME_ENFORCE=true` y `DB_RUNTIME_ROLE=finops_runtime`.

## Rollback

En desarrollo se puede desactivar temporalmente el enforcement para diagnóstico:

```text
DB_RUNTIME_ENFORCE=false
```

En producción no se debe usar ese valor: `runtimeConfig` rechaza el arranque
productivo si no es `true`. El rollback productivo es de despliegue: detener la
versión nueva, conservar las migraciones y el rol `finops_runtime`, restaurar la
última versión compatible y guardar logs/diagnóstico. No se deben revertir
migraciones ni eliminar datos como respuesta a un fallo de aplicación.

Después de corregir la causa, repetir migraciones, canary y pruebas funcionales
antes de volver a promover la versión. La activación permanente queda pendiente
hasta disponer de un destino de despliegue y un mecanismo de rollback operativo.
