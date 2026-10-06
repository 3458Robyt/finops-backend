# Roadmap de producto FinOps

Estado al 6 de octubre de 2026. El roadmap separa implementación en el repositorio de validación empresarial; tener código no significa que el flujo haya superado UAT.

## Cierre de la beta — prioridad inmediata

1. Ejecutar pruebas de integración desde migraciones cero contra PostgreSQL aislado y verificar aislamiento tenant-scoped.
2. Hacer UAT supervisada por rol: cliente lector/aprobador, técnico y administrador maestro; capturar fallos sin usar datos de otro tenant.
3. Verificar en el entorno autorizado la cobertura y frescura de inventario, métricas y FOCUS; comparar conteos de la API con consultas de control.
4. Probar una recomendación extremo a extremo: evidencia, auditoría, decisión humana, plan, ejecución autorizada y medición comparable. No informar ahorro hasta que el cálculo sea verificable.
5. Medir latencia de chat/análisis y observar workers, reintentos, fallos y límites del proveedor.

## Integraciones de nube

- OCI: conservar las rutas disponibles y validar cada fuente/permisos por cuenta y región. No inferir que una métrica existe porque aparezca en el catálogo.
- AWS: mantener la integración preparada, pero no darla por validada hasta disponer de una identidad de workload y una cuenta de prueba autorizadas.
- Otras nubes: considerar solo después de cerrar calidad de datos y operación multicloud actual.

## Operación y gobernanza

- Documentar despliegues, recuperación, rotación de secretos, actualización de dependencias y responsables.
- Automatizar CI y pruebas de integración con bases efímeras; mantener credenciales externas fuera de repositorios y artefactos.
- Activar correo/Telegram únicamente con configuración y destinatarios aprobados; comprobar entregabilidad y apagado seguro.
- Actualizar este documento con evidencia fechada y estado: abierto, bloqueado, diferido o cerrado.
