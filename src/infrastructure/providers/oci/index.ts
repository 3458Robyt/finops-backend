/**
 * Barrel del proveedor Oracle Cloud (OCI).
 *
 * Reexporta el adaptador {@link OCIProvider} para que la composición de
 * dependencias lo importe desde la carpeta del proveedor sin acoplarse a la
 * ruta interna del archivo de implementación. La carga del proveedor OCI se
 * hace de forma diferida (import dinámico) en el arranque solo si está habilitado.
 *
 * @module infrastructure/providers/oci
 */
export { OCIProvider } from './OCIProvider.js';
