# Onboarding cloud por tenant

> Documento operativo autoritativo. Estado verificado: 2026-08-29.

## Alcance y arquitectura

El onboarding reutiliza `cloud_connections`, credenciales cifradas, `ingestion_jobs`, watermarks,
quality checks, el scheduler y el worker persistente. No existe una segunda ruta de ingesta ni se
aprovisiona IAM desde FinOps.

El flujo normal se realiza en **Ingesta > Configurar cuentas cloud**:

1. Seleccionar el tenant activo.
2. Crear una conexión OCI o AWS.
3. Guardar una credencial read-only como candidata cifrada.
4. El backend confirma rápidamente el almacenamiento y devuelve `nextAction=VALIDATE`; la UI inicia la validación en una segunda operación no bloqueante.
5. La firma se valida antes de consultar capacidades y la candidata solo se activa si la autenticación remota es aceptada.
6. Configurar costos, FOCUS y métricas.
7. Previsualizar FOCUS sin ingerir.
8. Activar la sincronización inicial y el backfill.
9. Corregir o reintentar únicamente las fuentes fallidas.
10. Consultar Dashboard, Inventario y Métricas técnicas.

El estado es derivado de conexión, credenciales, validación, configuración y jobs. No se persiste
un estado monolítico de onboarding.

## Permisos de FinOps

| Operación | MASTER_ADMIN / ADMIN / OPERATOR_ADMIN | FINOPS_TECHNICIAN | VIEWER |
|---|---:|---:|---:|
| Consultar conexiones y readiness del tenant | Sí | Sí | Sí |
| Crear, editar o deshabilitar una conexión | Sí | Sí | No |
| Guardar o revocar credenciales | Sí | Sí | No |
| Validar, configurar fuentes y activar | Sí | Sí | No |
| Encolar, reintentar o cancelar jobs | Sí | Sí | No |

El `tenantId` se obtiene del JWT/contexto activo. Los repositorios vuelven a comprobar la
pertenencia; una conexión de otro tenant se responde como no encontrada.

## Credenciales

Las credenciales se cifran con AES-256-GCM mediante `CredentialCipher`. La respuesta solo contiene
ID, propósito, estado, etiqueta, principal externo, estado/mensaje de validación y fechas. Nunca devuelve
private key, passphrase, ExternalId, access keys, session tokens ni payload cifrado.

El reemplazo usa un ciclo seguro: `PENDING`/`INVALID` no se usa para ingesta; la credencial `ACTIVE`
anterior permanece disponible hasta que una solicitud firmada confirme la candidata. Una candidata
rechazada queda retenida cifrada para revocación manual, sin desplazar la activa. Un fallo transitorio
queda `PENDING` y puede reintentarse desde la UI.

### AWS

FinOps recibe un `roleArn`, `externalId` único por cliente y región. El backend controla el
`sessionName` y usa STS `AssumeRole`; no solicita usuario, contraseña ni access keys del cliente.

En desarrollo local, el backend obtiene las credenciales de origen mediante un perfil AWS nombrado
(`AWS_PROFILE`) autenticado con AWS CLI v2 (`aws login --profile finops-local`). No deben configurarse
`AWS_ACCESS_KEY_ID` ni `AWS_SECRET_ACCESS_KEY` permanentes en `.env`. La identidad de origen debe ser
una identidad de desarrollo no raíz con MFA; el perfil local solo necesita iniciar sesión y poder
ejecutar `sts:AssumeRole` sobre el rol de lectura registrado. La sesión local es temporal y requiere
renovarse según AWS CLI.

La policy del rol debe conceder solo las capacidades utilizadas:

- inventario: `ec2:DescribeInstances`, `ec2:DescribeVolumes` y `ec2:DescribeRegions`;
- métricas: `cloudwatch:ListMetrics` y `cloudwatch:GetMetricData`;
- costos directos: `ce:GetCostAndUsage`;
- FOCUS: `s3:ListBucket` limitado al prefijo y `s3:GetObject` para el export.

La trust policy debe restringir el principal operador y exigir el ExternalId aleatorio, exclusivo y
estable de la conexión. La sesión STS solicitada por el backend dura una hora. Si el bucket usa una
clave KMS administrada por el cliente, se requiere además `kms:Decrypt` sobre esa clave.

Para costos completos y vinculables a recursos, configura AWS Data Exports **FOCUS 1.2** en S3 como
CSV comprimido con GZIP, especifica la versión `1.2` en la plataforma y concede lectura solo sobre
el bucket/prefijo. El ingestor actual no admite Parquet. Cost Explorer es respaldo válido para totales
por servicio, pero sus filas no llevan `resourceId` y no justifican atribuir costos ni ahorros a una
instancia particular. `AUTO` prioriza FOCUS cuando está configurado; no mezcla ambas fuentes para el
mismo rango.

Antes de crear un export, verifica si la cuenta es pagadora/independiente o miembro de una
organización: la disponibilidad de los datos de facturación depende de la vista y los permisos del
principal. La configuración de exportación y S3 se realiza en AWS; el onboarding de FinOps no crea
roles, policies, buckets ni exports.

### OCI

FinOps recibe `tenancyId`, `userId`, `privateKey`, región y, si aplica, passphrase. El fingerprint
se deriva automáticamente desde la clave pública RSA del PEM y se conserva junto con el secreto
cifrado; si se envía un fingerprint legado, se compara y se rechaza cualquier discrepancia. Se
aceptan saltos de línea escapados, CRLF y el marcador opcional `OCI_API_KEY`, que no se entrega al SDK.
La llave PEM se cifra inmediatamente. El usuario/grupo debe tener policies read-only para las
capacidades utilizadas:

- identidad y tenancy;
- Compute para inventario;
- Monitoring para métricas;
- Usage API para costo directo;
- Object Storage para listar y leer FOCUS.

El onboarding no crea usuarios, grupos, policies, compartments, buckets ni recursos cloud.

### Candidatas, idempotencia y errores de entrada

El endpoint de almacenamiento valida localmente el formato PEM, el tipo RSA, el tamaño mínimo,
la passphrase y la correspondencia del Tenancy OCID antes de cifrar. Para OCI deriva el fingerprint
desde la clave pública y lo guarda como identidad técnica no secreta. Si se vuelve a enviar la misma
clave para la misma conexión y propósito, se reutiliza la candidata viva (`PENDING`, `ACTIVE` o
`INVALID`) en lugar de crear un duplicado. Los errores de campos incluyen una etapa, campo afectado
y código de acción seguros; nunca incluyen la clave, la passphrase ni el payload cifrado.

La UI ofrece selector de archivo `.pem`/`.key` o pegado manual, limpia el contenido sensible después
de guardarlo y muestra ayuda contextual accesible mediante hover, foco y clic. Las opciones de
métricas, fuente de costos y control de jobs permanecen dentro de una sección técnica avanzada
opcional para que el flujo principal de conexión sea autoexplicativo.

## Validación de capacidades

`POST /api/v1/cloud-connections/:id/credentials/:credentialId/validate` permite reintentar una
candidata `PENDING` o `INVALID` sin tocar la credencial activa. `POST /api/v1/cloud-connections/:id/validate`
comprueba la credencial activa y cada capacidad de forma independiente:

| Capacidad | Resultado posible | Efecto |
|---|---|---|
| Autenticación | VERIFIED / REJECTED / RETRYABLE_ERROR / NOT_CONFIGURED | Decide si la candidata puede promoverse |
| IDENTITY | AVAILABLE / DENIED / ERROR | Comprueba identidad; un 403 puede significar firma válida sin policy suficiente |
| INVENTORY | AVAILABLE / DENIED / BLOCKED / ERROR | Habilita `cloud_resources` |
| COSTS | AVAILABLE / DENIED / BLOCKED / ERROR | Habilita API directa |
| METRICS | AVAILABLE / DENIED / BLOCKED / NOT_CONFIGURED / ERROR | Habilita muestras técnicas |
| STORAGE | AVAILABLE / DENIED / BLOCKED / NOT_CONFIGURED / ERROR | Habilita FOCUS |

Una conexión puede quedar parcialmente operativa. Para activarla se exige autenticación verificada y
al menos una capacidad de datos disponible. Si OCI devuelve un error de firma HTTP, las demás
capacidades quedan `BLOCKED` y no se realizan llamadas redundantes. Un permiso ausente después de
una firma válida no invalida automáticamente los demás recursos.

Una API key OCI recién registrada puede devolver temporalmente un rechazo de firma antes de quedar
disponible para solicitudes firmadas. Durante los primeros cinco minutos desde el almacenamiento,
FinOps conserva la candidata `PENDING` y la UI realiza tres reintentos no bloqueantes (10, 30 y 60
segundos). La candidata sigue siendo fail-closed: solo pasa a `ACTIVE` después de una respuesta
firmada aceptada; fuera de la ventana, un rechazo persistente queda `INVALID`.

La comprobación de `COSTS` usa OCI Usage API con granularidad diaria y rangos alineados a días UTC
completos. El día UTC parcial actual se excluye para cumplir la precisión exigida por el SDK.

## Configuración de fuentes

### Costos

- `AUTO`: usa FOCUS configurado; de lo contrario intenta API directa.
- `FOCUS`: exige un objeto o ubicación FOCUS válida.
- `PROVIDER_API`: usa AWS Cost Explorer u OCI Usage API.

La procedencia se conserva por conexión y fila; no se mezclan silenciosamente resultados FOCUS y
API directa para el mismo rango.

### Preview FOCUS

`POST /api/v1/cloud-connections/:id/focus-preview` lista objetos `.csv`/`.csv.gz` con límite y
timeout. No descarga contenido ni escribe costos. Devuelve objetos encontrados, formatos, fechas,
tamaños disponibles y errores por ubicación. Una ubicación inválida no oculta las válidas.

### Métricas

`PUT /api/v1/cloud-connections/:id/metric-definitions` acepta entre 1 y 100 definiciones y elimina
campos desconocidos antes de persistir.

- OCI: compartment, namespace, métrica, recurso y query/unidad opcionales.
- AWS: recurso, namespace, métrica, stat, región/unidad opcionales y 1–20 dimensiones.

FOCUS no se usa para inferir CPU, memoria, red, disco ni IOPS. Memoria puede requerir OCI Compute
Agent o CloudWatch Agent.

## Sincronización y recuperación

`POST /api/v1/cloud-connections/:id/activate` responde `202` y crea ventanas persistentes para
inventario, costos y métricas según la configuración disponible. No espera a los proveedores.

Las ventanas se alinean y tienen unicidad parcial mientras están `PENDING` o `RUNNING`. La
persistencia de FOCUS y métricas es idempotente. Las operaciones disponibles son:

- reintentar ventanas `FAILED` sin duplicar las exitosas;
- cancelar ventanas `PENDING` por fuente;
- dejar terminar una ventana `RUNNING`;
- deshabilitar la conexión sin borrar histórico.

El readiness informa conexión, credencial, validación, fuentes, jobs, bloqueos, datos afectados y
acción recomendada. Estados: sin credencial, requiere validación, sincronizando, parcial, listo o
requiere atención.

## Endpoints

| Método y ruta | Uso |
|---|---|
| `GET /api/v1/cloud-connections/providers` | Catálogo OCI/AWS |
| `GET /api/v1/cloud-connections` | Conexiones del tenant |
| `POST /api/v1/cloud-connections` | Crear conexión |
| `GET /api/v1/cloud-connections/:id/onboarding` | Detalle seguro y reanudable |
| `PATCH /api/v1/cloud-connections/:id` | Editar nombre/región |
| `PATCH /api/v1/cloud-connections/:id/status` | Habilitar/deshabilitar |
| `POST /api/v1/cloud-connections/:id/credentials` | Guardar/reemplazar credencial |
| `DELETE /api/v1/cloud-connections/:id/credentials/:credentialId` | Revocar localmente |
| `POST /api/v1/cloud-connections/:id/credentials/:credentialId/validate` | Reintentar candidata pendiente/rechazada |
| `POST /api/v1/cloud-connections/:id/validate` | Validar capacidades |
| `PUT /api/v1/cloud-connections/:id/billing-source` | AUTO/FOCUS/PROVIDER_API |
| `POST /api/v1/ingestion/focus-sources` | Configurar ubicación/objeto FOCUS |
| `POST /api/v1/cloud-connections/:id/focus-preview` | Preview read-only |
| `PUT /api/v1/cloud-connections/:id/metric-definitions` | Configurar métricas |
| `POST /api/v1/cloud-connections/:id/activate` | Sincronización inicial |
| `POST /api/v1/cloud-connections/:id/ingestion-jobs` | Encolar ventana concreta |
| `POST /api/v1/cloud-connections/:id/ingestion-jobs/retry-failed` | Reintentar fallos |
| `POST /api/v1/cloud-connections/:id/ingestion-jobs/cancel-pending` | Cancelar pendientes |
| `GET /api/v1/ingestion/readiness` | Readiness consolidado del tenant |

## Solución de problemas

| Síntoma | Causa probable | Acción |
|---|---|---|
| Sin credencial | No existe una credencial activa | Guardar credencial read-only |
| Requiere validación | Credencial nueva o rotada | Ejecutar Validar acceso |
| Candidata rechazada | La firma OCI no coincide con la API key registrada | Comparar usuario, tenancy, fingerprint derivado y clave pública; revocar la candidata cuando corresponda |
| Candidata pendiente | Proveedor no respondió o agotó timeout | Reintentar validación; la credencial activa anterior sigue operativa |
| COSTS denegado | Policy de Usage/Cost Explorer insuficiente | Conceder lectura o usar FOCUS |
| Métricas no configuradas | Falta definición vinculada a recurso | Agregar definición Monitoring/CloudWatch |
| Memoria ausente | Agente del proveedor no instalado | Instalar agente o no usar esa señal |
| FOCUS sin objetos | Bucket/prefix incorrecto o sin permisos | Ejecutar preview y corregir ubicación |
| Canary no inicia por `CREDENTIAL_ENCRYPTION_KEY` | El backend no puede descifrar candidatos guardados | Configurar la misma clave de cifrado del entorno que creó las credenciales; no generar otra sobre datos existentes |
| Jobs fallidos | Error recuperable del proveedor/configuración | Corregir y reintentar esa fuente |
| Datos desactualizados | Backend/worker apagado en desarrollo | Ejecutar scheduler/worker manualmente |

## Comandos de verificación

```powershell
npm run typecheck
npm test
npm run build
npm run test:api:onboarding
npm run test:canary:oci-onboarding
npx tsx scripts/validate-oci-credential.ts <connection-id>
```

Para revisar credenciales creadas antes del ciclo seguro, primero ejecuta el dry-run:

```powershell
npm run oci:reconcile-credentials
```

Después de revisar la lista y confirmar que corresponde a firmas OCI rechazadas, aplica la
clasificación manual:

```powershell
npm run oci:reconcile-credentials -- --apply
```

El script no descifra secretos ni contiene IDs fijos. Solo marca como `INVALID` credenciales OCI
operativas cuya evidencia histórica indica rechazo de firma; nunca las elimina.

El canary OCI exige configuración local válida y solo ejecuta lecturas. La validación explícita de
una candidata (`validate-oci-credential.ts`) sí actualiza el estado de esa credencial en la BD:
promueve solo una candidata cuya autenticación sea aceptada y conserva como `INVALID` una rechazada.
Ninguno de los dos scripts modifica recursos cloud ni imprime secretos.

La integración y Playwright completo también fueron verificados contra un schema PostgreSQL
efímero `finops_e2e_*`. El cliente Prisma configura ese schema tanto para queries generadas como
para SQL raw y el schema se elimina después de la ejecución.

## Fuentes oficiales

- AWS: acceso de terceros mediante roles y ExternalId:
  https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_common-scenarios_third-party.html
- AWS CloudWatch `GetMetricData`:
  https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricData.html
- OCI: métodos de autenticación del SDK:
  https://docs.oracle.com/en-us/iaas/Content/API/Concepts/sdk_authentication_methods.htm
- OCI: archivo de configuración SDK/CLI:
  https://docs.oracle.com/en-us/iaas/Content/API/Concepts/sdkconfig.htm

## Fuera de alcance

No se almacenan usuarios/contraseñas cloud, no se crean policies IAM, no se remedian recursos y no
se eliminan datos históricos. Los scripts CLI permanecen como soporte técnico; la ruta normal es la
UI/API integrada.
