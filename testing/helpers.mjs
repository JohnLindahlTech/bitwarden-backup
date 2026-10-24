import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_BW = fileURLToPath(new URL('./fixtures/fake-bw.mjs', import.meta.url));
export const FAKE_7Z = fileURLToPath(new URL('./fixtures/fake-7z.mjs', import.meta.url));

process.env.LOG_LEVEL = 'error';

export const CREDENTIALS = { clientId: 'user.client-id', clientSecret: 'client-secret', masterPassword: 'master-pw', passphrase: 'archive-pass' };

export async function makeSandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bwbu-test-'));
  const credentialsFile = path.join(dir, 'creds.json');
  await fs.writeFile(credentialsFile, JSON.stringify(CREDENTIALS), { mode: 0o600 });
  process.env.FAKE_BW_LOG = path.join(dir, 'bw.log');
  process.env.FAKE_7Z_LOG = path.join(dir, '7z.log');
  process.env.FAKE_7Z_PASSPHRASE = CREDENTIALS.passphrase;
  delete process.env.FAKE_BW_FAIL;
  delete process.env.FAKE_BW_FAIL_FILE;
  delete process.env.FAKE_BW_EXTRA_ORGS;
  delete process.env.FAKE_BW_TARGET_DIR;
  delete process.env.FAKE_BW_FAIL_ATTACH;
  const readLog = async (file) => (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    dir,
    credentialsFile,
    bwCalls: () => readLog(process.env.FAKE_BW_LOG),
    argv: (overrides = {}) => ({
      credentialsFile, backupDir: path.join(dir, 'target'), tempDir: path.join(dir, 'ws'),
      ensureFresh: true, includePersonal: true, includeOrg: true, includeFiles: true,
      encrypt: true, cleanUp: true, ...overrides,
    }),
    deps: { bwBin: FAKE_BW, sevenZipBin: FAKE_7Z },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

export const exists = (p) => fs.access(p).then(() => true, () => false);
