# Deuda técnica abierta

Registro breve del trabajo que aún necesita validación; este archivo no contiene telemetría ni resultados privados de cuentas cloud.

| ID | Estado | Pendiente | Criterio de cierre |
|---|---|---|---|
| QA-DB-001 | ABIERTO | Ejecutar integración completa con PostgreSQL aislado desde cero. | Migraciones, RLS, repositorios y cleanup pasan en base desechable; cero residuos. |
| UAT-001 | ABIERTO | Recorrido autenticado de cliente, técnico y administrador maestro. | Flujos y permisos firmados por responsables humanos; defectos registrados y corregidos. |
| ING-001 | ABIERTO | Comprobar cobertura y frescura de costos e indicadores por fuente. | Conteos conciliados, huecos explicados y muestras vinculadas al recurso correcto. |
| AI-001 | ABIERTO | Validar calidad económica y latencia con evidencia autorizada. | Sin ahorro inventado; auditoría independiente, tiempos y decisiones trazables. |
| AWS-001 | BLOQUEADO | Probar ingesta contra AWS. | Cuenta de prueba y rol `AssumeRole` autorizados disponibles. |
| DEP-001 | DIFERIDO | Resolver vulnerabilidades de desarrollo que requieren Tailwind v4. | Actualización mayor con regresión UI aprobada. |
| OPS-001 | DIFERIDO | Definir monitoreo productivo continuo y respuesta a incidentes. | Entorno y responsables operativos aprobados. |

Las pruebas de este corte no accedieron a una base empresarial, proveedor cloud real ni canal de mensajería real.
