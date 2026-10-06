# FinOps Inteligente — backend

API y procesos de fondo de la plataforma de gestión FinOps. Este repositorio contiene la capa de dominio, casos de uso, adaptadores de nube, persistencia PostgreSQL, API HTTP y workers.

> **Estado de entrega:** software en desarrollo y candidato de evaluación. Que el repositorio sea público no significa que el sistema esté certificado para producción ni que TAK haya firmado su aceptación. La UAT autenticada por rol y la validación operativa de la empresa se registran por separado.

## Arquitectura y tecnología

- Node.js 22 y TypeScript ESM.
- Express, Zod y JWT; contraseñas con Argon2 y credenciales cloud cifradas.
- PostgreSQL y Prisma 7.
- SDKs OCI y AWS; ingesta de inventario, costos FOCUS/API y métricas.
- Pasarela configurable compatible con OpenAI para chat, análisis y auditoría IA.
- Workers independientes para ingesta, análisis y mensajería.

El código está organizado en `src/domain`, `src/application`, `src/infrastructure` y `src/presentation`. La configuración de runtime se documenta en [`.env.example`](.env.example); nunca se copian secretos reales al repositorio.

## Requisitos

- Node.js 22 LTS y npm compatible.
- PostgreSQL 17 accesible mediante una URL local para desarrollo.
- Credenciales cloud y proveedor IA solo para pruebas autorizadas con esos servicios.

## Inicio local

1. Instale PostgreSQL y cree una base de datos **de desarrollo**, o use la instancia local preparada si existe.
2. Desde esta carpeta, ejecute `npm ci`.
3. Copie `.env.example` a `.env` y complete solo secretos locales nuevos. No reutilice valores de producción ni suba `.env` a Git.
4. Configure `DATABASE_URL`, `JWT_SECRET` y `CREDENTIAL_ENCRYPTION_KEY`. Para chat/IA, configure también el endpoint, modelo y clave del proveedor elegido.
5. Genere Prisma y aplique las migraciones en esa base local:

   ```powershell
   npm run prisma:generate
   npx prisma migrate deploy
   ```

6. Inicie la API con `npm run dev`. La URL local predeterminada es `http://localhost:3000/api/v1`.

`npm run db:local:start` usa la instalación local configurada por el equipo; no crea una base automáticamente. `npm run db:seed` inserta datos demostrativos y requiere `SEED_DEFAULT_PASSWORD`; no se debe ejecutar sobre datos empresariales.

## Pruebas

```powershell
npm run check:architecture
npm run check:release-hygiene
npm run typecheck
npm run test:unit
npm run test:ai:offline
npm run build
```

`npm run test:all` ejecuta esas verificaciones juntas. Las pruebas PostgreSQL se ejecutan con una base desechable y `TEST_DATABASE_URL`, usando schemas `finops_e2e_*`; no se debe apuntar ese runner a una base compartida. Canaries de IA/cloud/mensajería son opt-in y requieren autorización, configuración local y servicios disponibles. No se envían mensajes reales durante las pruebas offline.

## Operación y referencias

- [Estado actual](docs/ESTADO_ACTUAL_FINOPS.md)
- [Roadmap de producto](docs/ROADMAP_PRODUCTO.md)
- [Deuda técnica](docs/DEUDA_TECNICA.md)
- [Conexiones cloud](docs/ONBOARDING_CLOUD.md)
- [Operación de ingesta](docs/INGESTION_OPERATIONS.md)
- [Prácticas de seguridad](docs/MODELO_AMENAZAS_STRIDE.md)

Los informes que contienen telemetría, identificadores o resultados de una cuenta empresarial se conservan en el paquete privado de entrega y no forman parte del repositorio público. Para una instancia nueva, cree credenciales propias y siga el principio de mínimo privilegio. AWS real requiere una identidad de carga de trabajo autorizada; no se deben publicar credenciales bootstrap.

## Uso y licencia

La visibilidad pública permite consultar el código, pero no concede por sí sola derechos de redistribución o uso comercial. El proyecto no declara una licencia open source.
