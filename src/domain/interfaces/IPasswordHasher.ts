/**
 * Contrato del servicio de hashing de contraseñas.
 *
 * Representa la abstracción de dominio para el cifrado y verificación
 * de credenciales. Pertenece a la capa de dominio (puerto), mientras que
 * la implementación concreta (e.g., bcrypt, argon2) reside en la capa de
 * infraestructura. Aplica el principio de inversión de dependencias (DIP):
 * los casos de uso dependen de esta interfaz y no de un algoritmo concreto.
 */
export interface IPasswordHasher {
  /**
   * Calcula el hash seguro de una contraseña en texto plano.
   *
   * @param password - Contraseña en texto plano proporcionada por el usuario.
   * @returns Promesa que resuelve con el hash resultante (incluye sal y parámetros del algoritmo).
   */
  hash(password: string): Promise<string>;

  /**
   * Verifica que una contraseña en texto plano corresponda a un hash previamente generado.
   *
   * @param hash     - Hash almacenado contra el cual se compara.
   * @param password - Contraseña en texto plano a validar.
   * @returns Promesa que resuelve `true` si la contraseña coincide con el hash, `false` en caso contrario.
   */
  verify(hash: string, password: string): Promise<boolean>;
}
