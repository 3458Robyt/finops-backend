# Estado actual de FinOps Inteligente

Corte del código fuente candidato a publicación: 6 de octubre de 2026. Este archivo describe capacidades presentes en el repositorio; no certifica que estén activas en un despliegue concreto ni que un cliente haya aceptado el sistema.

## Arquitectura

La solución está separada en una aplicación web React/TypeScript y un backend Node.js/TypeScript con capas de dominio, aplicación, infraestructura y presentación. PostgreSQL con Prisma conserva datos tenant-scoped. Procesos de worker gestionan ingesta, análisis y mensajería. Los proveedores de nube y de IA se integran desde el backend; el navegador no debe recibir sus secretos.

## Capacidades presentes en el código

- Gestión multi-tenant, roles, sesiones y MFA.
- Conexión y validación de credenciales de OCI y AWS, con estado de capacidad por servicio.
- Ingesta de inventario, métricas técnicas y costos normalizados/FOCUS, jobs con progreso y operación separada del API.
- Paneles de costos, inventario, métricas técnicas, presupuestos, asignación de costos y valor realizado.
- Motor de recomendaciones con compuertas determinísticas de evidencia, generación asistida por IA, auditor independiente, decisiones, planes y trazabilidad.
- Chat web contextual y canales configurables de correo SMTP y Telegram. Su disponibilidad real depende de configuración y activación del entorno.

## Verificación de este corte

El backend pasó instalación limpia, arquitectura, higiene de publicación, suite unitaria/offline y build: 843 pruebas aprobadas y una omitida en 162 archivos; suite IA offline 44/44. La auditoría de dependencias de producción no reportó vulnerabilidades. El frontend pasó `npm ci`, lint y build; su auditoría de producción también reportó cero vulnerabilidades. La auditoría completa del frontend encontró cinco vulnerabilidades altas y dos moderadas en dependencias de desarrollo asociadas a Tailwind y herramientas relacionadas; su corrección requiere una migración mayor y queda diferida con regresión visual.

No se ejecutó en este corte una integración contra una base aislada, un canary live de IA/nube, una prueba autenticada de negocio ni UAT. Las pruebas de código no equivalen a datos completos, ahorro realizado o aceptación empresarial.

## Límites conocidos

- AWS requiere una identidad de workload autorizada y una cuenta de prueba antes de validar el ciclo cloud completo.
- La calidad económica de recomendaciones debe validarse con evidencia técnica suficiente, tarifas comparables y revisión humana.
- La ingesta y los workers requieren operación y supervisión del entorno donde se despliegan.
- Correo y Telegram requieren credenciales propias y autorización para habilitar entregas reales.
