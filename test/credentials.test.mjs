import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { loadCredentials, redactor } from '../src/credentials.mjs';
import { makeSandbox } from '../testing/helpers.mjs';

test('loads a valid, private credentials file', async () => {
  const sb = await makeSandbox();
  const creds = await loadCredentials(sb.credentialsFile);
  assert.equal(creds.masterPassword, 'master-pw');
  await sb.cleanup();
});

test('refuses a file readable by group/others', async () => {
  const sb = await makeSandbox();
  await fs.chmod(sb.credentialsFile, 0o644);
  await assert.rejects(loadCredentials(sb.credentialsFile), /chmod 600/);
  await sb.cleanup();
});

test('errors never contain file content or path', async () => {
  const sb = await makeSandbox();
  const bad = path.join(sb.dir, 'bad.json');
  await fs.writeFile(bad, '{"masterPassword": "super-secret" oops', { mode: 0o600 });
  for (const file of [bad, path.join(sb.dir, 'missing.json')]) {
    await assert.rejects(loadCredentials(file), (err) => !err.message.includes('super-secret') && !err.message.includes(file));
  }
  await sb.cleanup();
});

test('reports missing fields by name only', async () => {
  const sb = await makeSandbox();
  const partial = path.join(sb.dir, 'partial.json');
  await fs.writeFile(partial, '{"clientId":"x"}', { mode: 0o600 });
  await assert.rejects(loadCredentials(partial, ['clientId', 'masterPassword']), /missing fields: masterPassword$/);
  await sb.cleanup();
});

test('redactor masks every secret', () => {
  assert.equal(redactor({ a: 'one', b: 'two' })('one and two and one'), '*** and *** and ***');
});
