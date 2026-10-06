# Public release verification

Release candidate assembled on 2026-10-06 from the current beta development line. The repository retains the filtered commit graph and archived branch references. Per-account validation reports, customer telemetry, local database artifacts, credential-check helpers, and deployment-specific hostnames are intentionally excluded. Detailed business evidence stays in the separately controlled delivery package.

## Verification performed

- Backend: clean `npm ci`; architecture check (452 production source files); release-hygiene check; Prisma client generation; `npm run test:all` (162 test files, 843 passed, one skipped); AI offline suite (44/44); build; production dependency audit (zero reported vulnerabilities).
- Frontend: clean `npm ci`; lint; production build (436 modules); production dependency audit (zero reported vulnerabilities).
- Source/history scan: no matched real provider/API credentials, private customer validation reports, or Claude co-author trailers. The author name is retained while the personal email is replaced by the GitHub no-reply address. Synthetic security-test values are fixtures, not credentials.

## Known limits

- Full PostgreSQL integration from a fresh isolated database was not run because no disposable test database was available. Do not point integration runners at a shared or business database.
- The frontend full development dependency audit reports five high and two moderate findings in development tooling. The suggested remediation requires the major Tailwind v4 migration; it is deferred until a separate visual regression pass.
- No live cloud ingestion, live AI canary, message-delivery canary, authenticated customer UAT, or production deployment was performed as part of repository preparation.
- A passing offline suite does not prove production availability, customer acceptance, recommendation quality on every workload, or realized savings.
- The repository has no open-source license. Public visibility does not grant reuse rights.
