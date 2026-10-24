#!/usr/bin/env node
// Probes how `bw export --format zip` behaves for personal and organization vaults.
// Prints only counts and pass/fail. Never prints credentials, bw stdout or item names.
import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadCredentials, redactor } from '../src/credentials.mjs';

const BW = fileURLToPath(new URL('../node_modules/.bin/bw', import.meta.url));
const { values } = parseArgs({ options: { 'credentials-file': { type: 'string' }, find: { type: 'string' }, out: { type: 'string' } } });
const credentials = await loadCredentials(
  values['credentials-file'] ?? process.env.BWBU_CREDENTIALS_FILE,
  ['clientId', 'clientSecret', 'masterPassword'],
);
let redact = redactor(credentials);

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'bwbu-probe-'));
await fs.chmod(work, 0o700);
// With --out the zips are kept there (plaintext secrets!), otherwise they die with the temp dir.
const exportDir = values.out ? path.resolve(values.out) : work;
if (values.out) {
  await fs.mkdir(exportDir, { recursive: true, mode: 0o700 });
  await fs.chmod(exportDir, 0o700);
}
const baseEnv = {
  BITWARDENCLI_APPDATA_DIR: path.join(work, 'appdata'), // isolated from the user's own bw login
  BW_CLIENTID: credentials.clientId,
  BW_CLIENTSECRET: credentials.clientSecret,
  BW_PASSWORD: credentials.masterPassword,
  BW_NOINTERACTION: 'false',
};

async function bw(args, { env = {}, input } = {}) {
  try {
    const { stdout } = await execa(BW, args, { env: { ...baseEnv, ...env }, input, timeout: 120_000 });
    return { ok: true, stdout };
  } catch (err) {
    const firstLine = redact(err.stderr || err.shortMessage || '').split('\n')[0].slice(0, 200);
    return { ok: false, error: `exit ${err.exitCode ?? '?'}: ${firstLine}` };
  }
}

const step = (name, ok, detail = '') => console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);

async function zipSummary(file) {
  const { stdout } = await execa('unzip', ['-Z1', file]);
  const entries = stdout.split('\n').filter(Boolean);
  return { entries: entries.length, attachmentFiles: entries.filter((e) => e.includes('attachments/') && !e.endsWith('/')).length, hasJson: entries.some((e) => e.endsWith('.json')), found: values.find ? entries.some((e) => e.includes(values.find)) : null };
}

async function exportZip(label, extraArgs) {
  const out = path.join(exportDir, `${label}.zip`);
  const args = ['export', '--format', 'zip', '--output', out, ...extraArgs];
  const viaStdin = await bw(args, { env: { BW_SESSION: session }, input: credentials.masterPassword });
  if (!viaStdin.ok) return step(`export ${label}`, false, viaStdin.error);
  try {
    const s = await zipSummary(out);
    step(`export ${label}`, true, `zip entries=${s.entries}, attachment files=${s.attachmentFiles}, json=${s.hasJson}${s.found === null ? '' : `, found "${values.find}" in zip=${s.found}`}`);
  } catch {
    step(`export ${label}`, false, 'command succeeded but no readable zip was produced');
  }
}

let session;
try {
  console.log(`bw ${(await bw(['--version'])).stdout?.trim()}`);
  const login = await bw(['login', '--apikey']);
  step('login (apikey, no MFA prompt)', login.ok, login.error);
  if (!login.ok) process.exit(1);

  const unlock = await bw(['unlock', '--raw', '--passwordenv', 'BW_PASSWORD']);
  step('unlock', unlock.ok, unlock.error);
  if (!unlock.ok) process.exit(1);
  session = unlock.stdout.trim();
  redact = redactor({ ...credentials, session });

  const sync = await bw(['sync'], { env: { BW_SESSION: session } });
  step('sync', sync.ok, sync.error);

  await exportZip('personal', []);

  const orgs = await bw(['list', 'organizations'], { env: { BW_SESSION: session } });
  const orgList = orgs.ok ? JSON.parse(orgs.stdout) : [];
  step('list organizations', orgs.ok, orgs.ok ? `count=${orgList.length}` : orgs.error);

  for (const [i, org] of orgList.entries()) {
    const items = await bw(['list', 'items', '--organizationid', org.id], { env: { BW_SESSION: session } });
    if (items.ok) {
      const list = JSON.parse(items.stdout);
      const attachments = list.reduce((n, it) => n + (it.attachments?.length ?? 0), 0);
      const listed = values.find ? list.some((it) => it.attachments?.some((a) => a.fileName?.includes(values.find))) : null;
      step(`org#${i + 1} items`, true, `items=${list.length}, attachments per bw list=${attachments}${listed === null ? '' : `, found \"${values.find}\" in bw list=${listed}`}`);
    } else {
      step(`org#${i + 1} items`, false, items.error);
    }
    await exportZip(`org${i + 1}`, ['--organizationid', org.id]);
  }
} finally {
  await bw(['logout']);
  await fs.rm(work, { recursive: true, force: true });
  console.log(`logged out of isolated bw state, temp dir removed${values.out ? `; exports kept in ${exportDir}` : ''}`);
}
