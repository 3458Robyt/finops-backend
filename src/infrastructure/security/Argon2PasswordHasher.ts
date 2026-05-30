import argon2 from 'argon2';
import type { IPasswordHasher } from '../../domain/interfaces/IPasswordHasher.js';

/**
 * Adaptador de infraestructura que implementa la interfaz de dominio
 * {@link IPasswordHasher} usando la librería `argon2`.
 *
 * Responsabilidad: derivar y verificar hashes de contraseñas de usuario
 * empleando el algoritmo **Argon2id**, la variante recomendada por OWASP
 * por combinar resistencia frente a ataques por canal lateral (side-channel)
 * y frente a ataques de fuerza bruta acelerados por GPU.
 *
 * Parámetros criptográficos fijados:
 * - `type`: `argon2id` (variante híbrida).
 * - `memoryCost`: 19 456 KiB (~19 MiB) de memoria por cálculo de hash.
 * - `timeCost`: 2 iteraciones.
 * - `parallelism`: 1 hilo.
 *
 * El hash resultante incluye el salt y los parámetros codificados en el
 * propio string (formato PHC), por lo que la verificación no requiere
 * conocer la configuración por separado.
 */
export class Argon2PasswordHasher implements IPasswordHasher {
  /**
   * Calcula el hash Argon2id de una contraseña en texto plano.
   *
   * Cada invocación genera un salt aleatorio interno, por lo que dos llamadas
   * con la misma contraseña producen hashes distintos.
   *
   * @param password - Contraseña en texto plano a proteger.
   * @returns Hash en formato PHC (incluye variante, parámetros, salt y digest).
   */
  public async hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  }

  /**
   * Verifica si una contraseña en texto plano corresponde a un hash dado.
   *
   * Los parámetros de coste se leen del propio `hash` (formato PHC), de modo
   * que la verificación funciona aunque la configuración cambie en el futuro.
   *
   * @param hash - Hash Argon2 previamente generado por {@link hash}.
   * @param password - Contraseña en texto plano a comprobar.
   * @returns `true` si la contraseña coincide con el hash; `false` en caso contrario.
   */
  public async verify(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password);
  }
}
