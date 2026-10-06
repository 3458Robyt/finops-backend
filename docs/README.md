# Índice de documentación técnica

Esta carpeta reúne guías de operación y referencias de implementación del backend. El README de la raíz contiene los requisitos, la instalación local, las pruebas y el uso de Compose.

## Puesta en marcha y datos cloud

| Guía | Para qué sirve |
|---|---|
| [Onboarding cloud](ONBOARDING_CLOUD.md) | Crear y validar conexiones OCI/AWS y entender los permisos requeridos. |
| [Operación de ingesta](INGESTION_OPERATIONS.md) | Ejecutar, supervisar y diagnosticar los trabajos de ingesta. |
| [Canary de RLS runtime](RUNTIME_RLS_CANARY.md) | Verificar localmente el acceso PostgreSQL mediante el rol runtime dedicado. |
| [Recuperación](OPERACION_RECUPERACION.md) | Consultar el procedimiento de respaldo y recuperación de la base de datos. |

## Análisis y resultados FinOps

| Guía | Para qué sirve |
|---|---|
| [Pipeline de análisis FinOps](PIPELINE_ANALISIS_FINOPS.md) | Explica la evidencia, las reglas determinísticas, la generación y la auditoría de recomendaciones. |
| [Centro de realización de valor](VALUE_REALIZATION_CENTER.md) | Describe el ciclo de decisión, ejecución y seguimiento del valor. |
| [Medición de ahorros verificados](VERIFIED_SAVINGS_MEASUREMENT.md) | Define cuándo un ahorro posterior a la ejecución se puede considerar verificado. |

## Usuarios, seguridad y comunicación

| Guía | Para qué sirve |
|---|---|
| [Matriz de autorización](MATRIZ_AUTORIZACION.md) | Resume capacidades por rol; la política de autorización en el código es la fuente ejecutable. |
| [Seguridad de autenticación](MATRIZ_SEGURIDAD_AUTENTICACION.md) | Documenta amenazas y controles del inicio de sesión y la autenticación. |
| [Correo y Telegram](MENSAJERIA_CANAL_OPERACION.md) | Configura y diagnostica los canales de comunicación. |
| [Bot de Telegram](TELEGRAM_BOT.md) | Describe el enlace de usuarios, el contexto del tenant y los comandos disponibles. |

## Cómo interpretar estas guías

- La configuración efectiva se obtiene de las variables de entorno y del código desplegado; ante una discrepancia, valide ambos antes de operar.
- Las fechas que aparecen dentro de una guía identifican el momento de una revisión o prueba concreta, no una garantía de que el sistema esté certificado hoy.
- Use credenciales y bases de datos de prueba para seguir procedimientos de verificación. No copie secretos ni identificadores empresariales en issues, capturas o logs públicos.
- Los scripts y pruebas mencionados deben ejecutarse desde la raíz del backend, salvo que la guía indique otra cosa.
