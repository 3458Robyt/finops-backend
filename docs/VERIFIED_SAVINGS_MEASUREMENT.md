# Medición verificable del ahorro post-ejecución

## Semántica

- **Estimado:** importe original calculado por el motor de recomendaciones.
- **Reportado por el usuario:** valor manual capturado en `recommendation_manual_executions.observed_monthly_savings`; es informativo y no alimenta el ahorro confirmado.
- **Calculado/observado:** diferencia determinística entre el costo diario de una ventana base y el costo diario posterior.
- **Proyectado:** diferencia diaria multiplicada por 30.4375 días.
- **Verificado:** resultado calculado que una persona autorizada revisó y aprobó. Es el único valor que alimenta `confirmedMonthlySavings` y el ROI.
- **Aumento:** si el costo posterior es mayor, `projectedMonthlySavings` queda en cero y el aumento se conserva en `costIncreaseMonthlyAmount`; ese resultado no se puede verificar como ahorro.
- **Eficiencia por unidad:** cuando cantidad y unidad son comparables, también se guarda el costo por unidad y el cambio de volumen. Si el volumen cambia más del 20%, el resultado queda con confianza limitada y no prueba eficiencia por sí solo.

## Flujo

1. Un técnico registra una ejecución manual con fecha.
2. El backend excluye el día de ejecución y construye ventanas UTC base/posteriores de 7 días (también acepta 14 o 30).
3. PostgreSQL agrega `cost_metrics` por tenant, cuenta, proveedor, recurso/servicio/cuenta explícitos, moneda y fuente.
4. Se prefiere `EffectiveCost` cuando está completo y consistente; de lo contrario se usa `BilledCost` y se deja constancia.
5. La medición se guarda con hash de evidencia, fórmula, cobertura, datos antes/después y razones.
6. Un usuario autorizado verifica o rechaza el resultado. Una medición verificada es inmutable.
7. El usuario puede calcular o recalcular cuando la ventana ya tenga datos; un nuevo hash conserva el historial sin sobrescribir mediciones anteriores.

## Estados

`WAITING_FOR_DATA`, `READY`, `CALCULATED`, `INSUFFICIENT_EVIDENCE`, `VERIFIED`, `REJECTED`, `FAILED`.

Un incremento de costo se conserva como delta negativo y como `costIncreaseMonthlyAmount`; nunca se presenta como ahorro verificado.

Para recomendaciones ligadas a un recurso, la verificación exige métricas técnicas posteriores con CPU y memoria, al menos 48 muestras y 7 días de cobertura. Las señales de saturación reutilizan las reglas determinísticas existentes (p95 de 80% o más, p99 de CPU de 90% o más, o 20% de muestras sobre 80%) y bloquean la verificación.

## API

- `GET /api/v1/recommendations/:id/savings-measurements/readiness`
- `POST /api/v1/recommendations/:id/savings-measurements`
- `GET /api/v1/recommendations/:id/savings-measurements`
- `GET /api/v1/recommendations/:id/savings-measurements/:measurementId`
- `POST /api/v1/recommendations/:id/savings-measurements/:measurementId/verify`
- `POST /api/v1/recommendations/:id/savings-measurements/:measurementId/reject`

Las consultas están aisladas por tenant. El cálculo requiere rol operativo; verificar/rechazar admite roles operativos y `CLIENT_APPROVER`.

## Limitaciones deliberadas del MVP

- No usa LLM ni worker para calcular el ahorro.
- No convierte automáticamente históricos del campo manual legado.
- No usa el tenant como fallback de alcance: sin recurso, servicio o cuenta explícitos la medición queda con evidencia insuficiente.
- La ausencia de métricas técnicas no invalida la diferencia financiera, pero bloquea una afirmación técnica cuando la recomendación la exige.

## Migración

La tabla `recommendation_savings_measurements` se crea mediante la migración
`202607250001_verified_savings_measurements`. Primero debe aplicarse en un
entorno local o esquema aislado validado y después en Supabase. La migración
de normalización de unidades es `202607250002_savings_unit_normalization`.
Ambas ya están aplicadas en la base principal y en el esquema aislado de
integración `finops_e2e_verified_savings`. No contienen fixtures ni borran
datos existentes.

La integración se ejecuta con `TEST_DATABASE_URL` apuntando a un esquema
`finops_e2e_*`; nunca debe apuntar a la base principal. El cálculo se puede
repetir desde la UI o la API: el hash de evidencia evita duplicar el mismo
resultado y conserva los resultados históricos cuando cambia la evidencia.
