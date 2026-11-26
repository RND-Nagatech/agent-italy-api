/** Preserve the original backend's cursor behavior for ASCII-hex encryption. */
export function encryptLegacyAscii(value: string, key: string): string {
  if (!key) return value;
  let result = '', cursor = 0;
  for (const character of value) {
    result += (character.charCodeAt(0) + key.charCodeAt(cursor)).toString(16);
    if (cursor === key.length - 1) cursor = 0;
    cursor += 1;
  }
  return result.toUpperCase();
}

/** Returns the exact plaintext (including password whitespace), or null for invalid ciphertext. */
export function decryptLegacyAscii(value: string, key: string): string | null {
  if (!key || !/^(?:[a-f0-9]{2})+$/i.test(value)) return null;
  let result = '', cursor = 0;
  for (let index = 0; index < value.length; index += 2) {
    const code = Number.parseInt(value.slice(index, index + 2), 16) - key.charCodeAt(cursor);
    if (!Number.isFinite(code) || code < 0 || code > 0xffff) return null;
    result += String.fromCharCode(code);
    if (cursor === key.length - 1) cursor = 0;
    cursor += 1;
  }
  return encryptLegacyAscii(result, key) === value.toUpperCase() ? result : null;
}
