import { decryptLegacyAscii } from './legacy-ascii';

export type RdsSettings = { url: string; database: string; username: string; password: string };

export function decodeRdsSettings(values: RdsSettings, key: string): RdsSettings {
  if (!Object.values(values).some(Boolean)) return values;
  if (!key) throw new Error('RDS decryption key is missing');
  const decoded = Object.fromEntries(Object.entries(values).map(([name, value]) => {
    const plaintext = decryptLegacyAscii(value, key);
    if (!plaintext || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(plaintext)) throw new Error('Invalid encrypted RDS configuration');
    return [name, name === 'password' ? plaintext : plaintext.trim()];
  })) as RdsSettings;
  if (!/^[a-zA-Z0-9_$-]{1,64}$/.test(decoded.database) || !decoded.username || /\s/.test(decoded.url)) throw new Error('Invalid decrypted RDS configuration');
  parseRdsEndpoint(decoded.url, decoded.database);
  return decoded;
}

/** Accept an RDS hostname[:port] or a MariaDB URL; credentials stay in separate env keys. */
export function parseRdsEndpoint(value: string, database: string): { host: string; port: number; ssl?: true } {
  const parsed = new URL(value.includes('://') ? value : `mariadb://${value}`);
  if (!['mariadb:', 'mysql:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) throw new Error('Invalid RDS endpoint');
  if (parsed.pathname && parsed.pathname !== '/' && decodeURIComponent(parsed.pathname.slice(1)) !== database) throw new Error('RDS database differs');
  const port = parsed.port ? Number(parsed.port) : 3306;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || [...parsed.searchParams.keys()].some(key => key !== 'ssl') || parsed.searchParams.getAll('ssl').length > 1) throw new Error('Invalid RDS connection options');
  const ssl = parsed.searchParams.get('ssl');
  if (ssl !== null && ssl !== 'true' && ssl !== 'false') throw new Error('Invalid RDS TLS option');
  return { host: parsed.hostname.replace(/^\[|\]$/g, ''), port, ...(ssl === 'true' ? { ssl: true as const } : {}) };
}
