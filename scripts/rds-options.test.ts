import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decryptLegacyAscii, encryptLegacyAscii } from '../src/config/legacy-ascii';
import { decodeRdsSettings, parseRdsEndpoint } from '../src/config/rds-options';

test('legacy ASCII cipher retains the original cursor and exact credential whitespace', () => {
  assert.equal(encryptLegacyAscii('ABCD', 'abc'), 'A2A4A6A6');
  assert.equal(decryptLegacyAscii('A2A4A6A6', 'abc'), 'ABCD');
  const key = 'offline-fixture-key';
  const values = { url: 'mariadb://archive.invalid:3307?ssl=true', database: 'legacy_items', username: 'reader', password: ' p:a@ss ' };
  const encrypted = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, encryptLegacyAscii(value, key)])) as typeof values;
  assert.deepEqual(decodeRdsSettings(encrypted, key), values);
  assert.equal(decryptLegacyAscii('NOT-HEX', key), null);
  assert.throws(() => decodeRdsSettings(encrypted, ''), /key/);
  assert.throws(() => decodeRdsSettings(values, key), /encrypted/);
  assert.deepEqual(decodeRdsSettings({ url: '', database: '', username: '', password: '' }, ''), { url: '', database: '', username: '', password: '' });
});

test('decrypted RDS endpoints support explicit ports and verified TLS without embedded credentials or SQL options', () => {
  assert.deepEqual(parseRdsEndpoint('archive.invalid', 'legacy_items'), { host: 'archive.invalid', port: 3306 });
  assert.deepEqual(parseRdsEndpoint('archive.invalid:3307', 'legacy_items'), { host: 'archive.invalid', port: 3307 });
  assert.deepEqual(parseRdsEndpoint('mariadb://archive.invalid:3307/legacy_items?ssl=true', 'legacy_items'), { host: 'archive.invalid', port: 3307, ssl: true });
  for (const value of ['https://archive.invalid', 'mariadb://user:password@archive.invalid', 'mariadb://archive.invalid/wrong_db', 'mariadb://archive.invalid?multipleStatements=true', 'mariadb://archive.invalid?ssl=invalid', 'mariadb://archive.invalid:99999']) assert.throws(() => parseRdsEndpoint(value, 'legacy_items'));
});
