import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ConfigurationError } from '../../domain/errors/errors.js';

/**
 * Representa el resultado del cifrado autenticado de un payload de credenciales.
 *
 * Todos los campos binarios se serializan en **base64** para poder almacenarse
 * y transportarse como texto.
 */
export interface EncryptedCredentialPayload {
  /** Texto cifrado del payload (JSON serializado) codificado en base64. */
  readonly encryptedPayload: string;
  /** Vector de inicialización (IV) de 12 bytes, codificado en base64. */
  readonly encryptionIv: string;
  /** Etiqueta de autenticación GCM (auth tag) de 16 bytes, codificada en base64. */
  readonly encryptionAuthTag: string;
  /** Algoritmo de cifrado empleado. Constante: `aes-256-gcm`. */
  readonly encryptionAlgorithm: 'aes-256-gcm';
  /** Versión de la clave usada, para permitir rotación de claves (por defecto `v1`). */
  readonly encryptionKeyVersion: string;
}

/**
 * Adaptador de infraestructura encargado de cifrar y descifrar credenciales
 * sensibles (por ejemplo, secretos de conexión a proveedores cloud) mediante
 * **AES-256-GCM**, un esquema de cifrado autenticado (AEAD).
 *
 * Características criptográficas:
 * - Algoritmo: `aes-256-gcm` (clave de 256 bits / 32 bytes).
 * - IV: 12 bytes aleatorios generados con `randomBytes` en cada cifrado
 *   (recomendación estándar para GCM).
 * - Auth tag: 16 bytes que garantizan integridad y autenticidad del texto cifrado.
 *
 * Advertencias de seguridad:
 * - La clave (`CREDENTIAL_ENCRYPTION_KEY`) debe estar codificada en base64 y
 *   decodificar a **exactamente 32 bytes**; en caso contrario el constructor falla.
 * - Nunca se debe reutilizar el mismo par (clave, IV); aquí el IV es siempre
 *   aleatorio, por lo que esta propiedad se cumple por diseño.
 */
export class CredentialCipher {
  private readonly key: Buffer;
  private readonly keyVersion: string;

  /**
   * Inicializa el cifrador validando la clave de cifrado.
   *
   * @param rawKey - Clave de cifrado en base64. Por defecto se lee de la variable
   *   de entorno `CREDENTIAL_ENCRYPTION_KEY`. Debe decodificar a 32 bytes.
   * @param keyVersion - Identificador de versión de la clave para soportar rotación.
   *   Por defecto se lee de `CREDENTIAL_KEY_VERSION`, o `'v1'` si no está definida.
   * @throws {ConfigurationError} Si la clave no está configurada o está vacía.
   * @throws {ConfigurationError} Si la clave no decodifica a exactamente 32 bytes.
   */
  constructor(rawKey = process.env['CREDENTIAL_ENCRYPTION_KEY'], keyVersion = process.env['CREDENTIAL_KEY_VERSION'] ?? 'v1') {
    if (rawKey === undefined || rawKey.trim() === '') {
      throw new ConfigurationError('CREDENTIAL_ENCRYPTION_KEY must be configured as a base64 32-byte key');
    }

    const key = Buffer.from(rawKey, 'base64');

    if (key.length !== 32) {
      throw new ConfigurationError('CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes');
    }

    this.key = key;
    this.keyVersion = keyVersion;
  }

  /**
   * Cifra un objeto de credenciales con AES-256-GCM.
   *
   * El objeto se serializa a JSON (UTF-8), se cifra con un IV aleatorio de
   * 12 bytes y se devuelve junto con la etiqueta de autenticación y los
   * metadatos necesarios para el descifrado.
   *
   * @param payload - Objeto de credenciales a cifrar (clave-valor de solo lectura).
   * @returns Estructura {@link EncryptedCredentialPayload} con todos los campos en base64.
   */
  public encrypt(payload: Readonly<Record<string, unknown>>): EncryptedCredentialPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return {
      encryptedPayload: encrypted.toString('base64'),
      encryptionIv: iv.toString('base64'),
      encryptionAuthTag: cipher.getAuthTag().toString('base64'),
      encryptionAlgorithm: 'aes-256-gcm',
      encryptionKeyVersion: this.keyVersion,
    };
  }

  /**
   * Descifra y deserializa un payload previamente cifrado con {@link encrypt}.
   *
   * Valida la etiqueta de autenticación GCM: si el texto cifrado, el IV o el
   * auth tag han sido manipulados, `decipher.final()` lanzará un error.
   *
   * @param encrypted - Estructura de credenciales cifradas a recuperar.
   * @returns Objeto original de credenciales (clave-valor de solo lectura).
   * @throws {Error} Si la autenticación GCM falla (datos manipulados o clave incorrecta).
   * @throws {Error} Si el contenido descifrado no es un objeto JSON (p. ej. array o primitivo).
   */
  public decrypt(encrypted: EncryptedCredentialPayload): Readonly<Record<string, unknown>> {
    const decipher = createDecipheriv(
      encrypted.encryptionAlgorithm,
      this.key,
      Buffer.from(encrypted.encryptionIv, 'base64'),
    );

    decipher.setAuthTag(Buffer.from(encrypted.encryptionAuthTag, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted.encryptedPayload, 'base64')),
      decipher.final(),
    ]);

    const parsed: unknown = JSON.parse(decrypted.toString('utf8'));

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Decrypted credential payload is not an object');
    }

    return parsed as Readonly<Record<string, unknown>>;
  }
}
