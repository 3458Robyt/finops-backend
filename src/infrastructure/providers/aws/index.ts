/**
 * Barrel del proveedor AWS.
 *
 * Reexporta el adaptador {@link AWSProvider} para que la composición de
 * dependencias lo importe desde la carpeta del proveedor sin acoplarse a la
 * ruta interna del archivo de implementación.
 *
 * @module infrastructure/providers/aws
 */
export { AWSProvider } from './AWSProvider.js';
