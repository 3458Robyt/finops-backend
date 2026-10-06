# Operación de ingesta

## Componentes

La API valida las solicitudes y crea trabajos. El scheduler detecta ventanas pendientes según las capacidades verificadas de la conexión. El worker toma los trabajos, llama al adaptador cloud, normaliza resultados y persiste muestras e inventario. La UI consulta historial y estado; no necesita mantener abierta la página para que el worker procese la cola.

## Secuencia recomendada

1. Registrar una conexión y guardar credenciales cifradas en el backend.
2. Validar identidad, región y permisos; revisar las capacidades disponibles para inventario, costos y métricas.
3. Configurar una fuente de costos y confirmar que los objetos/reportes son legibles.
4. Solicitar una sincronización inicial dentro de los límites de retención y cuota del proveedor.
5. Revisar jobs, ventanas cubiertas, objetos procesados, errores y último dato persistido.
6. Comparar una muestra de la API con una consulta independiente y corregir fallos antes de habilitar una frecuencia periódica.

## Interpretación

Un job exitoso indica que una operación terminó; no certifica que todos los recursos o períodos tengan datos. Un catálogo de métricas indica que el proveedor reconoce una definición, no que la instancia la emita. Un período ausente no debe transformarse en cero. Mantener la unidad, estadística, región, dimensiones y hora del proveedor al interpretar muestras.

Los trabajos deben ser idempotentes, acotados y reintentables. El paralelismo debe respetar límites del proveedor y el presupuesto operativo. En desarrollo el worker puede ejecutarse manualmente; la ingesta periódica solo es confiable si el proceso correspondiente permanece activo y se supervisa.
