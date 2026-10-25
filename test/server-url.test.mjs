import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { backup } from '../src/backup.mjs';
import { loadCredentials } from '../src/credentials.mjs';
import { CREDENTIALS, makeSandbox } from '../testing/helpers.mjs';

async function credsWith(sb, extra) {
  const file = path.join(sb.dir, 'with-server.json');
  await fs.writeFile(file, JSON.stringify({ ...CREDENTIALS, ...extra }), { mode: 0o600 });
  return file;
}

test('serverUrl is optional and must be an http(s) URL', async () => {
  const sb = await makeSandbox();
  assert.equal((await loadCredentials(await credsWith(sb, { serverUrl: 'http://vaultwarden:80' }))).serverUrl, 'http://vaultwarden:80');
  for (const bad of ['not a url', 'ftp://x', 42]) {
    await assert.rejects(loadCredentials(await credsWith(sb, { serverUrl: bad })), (err) => /serverUrl must be an http\(s\) URL/.test(err.message) && !err.message.includes(String(bad)));
  }
  await sb.cleanup();
});

test('backup points bw at the configured server before logging in', async () => {
  const sb = await makeSandbox();
  const credentialsFile = await credsWith(sb, { serverUrl: 'http://vaultwarden:80' });
  await backup(sb.argv({ credentialsFile, cleanUp: false }), sb.deps);
  const calls = (await sb.bwCalls()).map((c) => c.args.slice(0, 3).join(' '));
  assert.equal(calls[0], 'config server http://vaultwarden:80');
  assert.equal(calls[1], 'login --apikey');
  await sb.cleanup();
});

test('without serverUrl bw keeps its default server', async () => {
  const sb = await makeSandbox();
  await backup(sb.argv({ cleanUp: false }), sb.deps);
  assert.equal((await sb.bwCalls()).some((c) => c.args[0] === 'config'), false);
  await sb.cleanup();
});
