import assert from 'node:assert/strict';
import { execa } from 'execa';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/index.mjs', import.meta.url));

// Regression: the Docker image sets env vars for all commands; the backup command must ignore the others'.
test('backup ignores env vars that belong to other commands', async () => {
  const r = await execa('node', [CLI, 'backup'], {
    reject: false,
    env: { BWBU_CREDENTIALS_FILE: '/nonexistent', BWBU_SOURCE_FILE: '/x.7z', BWBU_UNPACK_DIR: '/u' },
  });
  assert.doesNotMatch(r.stderr, /Unknown argument/);
  assert.match(r.stderr, /Credentials file could not be read/);
  assert.equal(r.exitCode, 1);
});

test('unknown commands are rejected', async () => {
  const r = await execa('node', [CLI, 'bogus'], { reject: false, env: { BWBU_CREDENTIALS_FILE: '/nonexistent' } });
  assert.notEqual(r.exitCode, 0);
});
