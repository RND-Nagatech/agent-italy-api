import { env } from '../config/env';

const HEX_PAIRS = /^(?:[0-9a-f]{2})+$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Decrypts tm_dept.nama_dept values using the legacy Encryptor.decryptascii
 * format. Plain text, invalid ciphertext, and undecodable values are returned
 * unchanged so a missing/misconfigured key cannot corrupt department labels.
 */
export function decryptDepartmentName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;

  const encrypted = value.trim();
  const key = env.encKeyDec;
  if (!key || !HEX_PAIRS.test(encrypted)) return encrypted;

  let decrypted = '';
  let keyIndex = 0;
  for (let index = 0; index < encrypted.length; index += 2) {
    const encryptedCode = Number.parseInt(encrypted.slice(index, index + 2), 16);
    const characterCode = encryptedCode - key.charCodeAt(keyIndex);
    if (!Number.isFinite(characterCode) || characterCode < 0 || characterCode > 0xffff) {
      return encrypted;
    }

    decrypted += String.fromCharCode(characterCode);
    // Match the legacy Encryptor's key cursor, including its reset sequence.
    if (keyIndex === key.length - 1) keyIndex = 0;
    keyIndex += 1;
  }

  if (!decrypted.trim() || CONTROL_CHARACTERS.test(decrypted)) return encrypted;
  return decrypted.trim();
}
