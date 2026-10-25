// Helpers for the end-to-end suite: everything runs against the real playground Vaultwarden and the real Docker image.
import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vwClient } from '../scripts/lib/vw-client.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BW_SCRIPT = path.join(ROOT, 'node_modules/@bitwarden/cli/build/bw.js');

// The containers run as the current user, so they can read the private (600) test credentials files.
const baseEnv = () => ({ ...process.env, BWBU_UID: String(process.getuid()), BWBU_GID: String(process.getgid()) });

async function compose(args, env = {}) {
  const r = await execa('docker', ['compose', '-f', 'compose.vaultwarden.yaml', ...args], { cwd: ROOT, env: { ...baseEnv(), ...env }, all: true, reject: false });
  return { exitCode: r.exitCode, output: r.all ?? '' };
}
async function composeOk(args, env) {
  const r = await compose(args, env);
  if (r.exitCode !== 0) throw new Error(`docker compose ${args.join(' ')} failed (exit ${r.exitCode}):\n${r.output.split('\n').slice(-25).join('\n')}`);
  return r.output;
}

export async function resetPlayground() {
  const r = await execa('node', ['scripts/playground.mjs', '--reset'], { cwd: ROOT, all: true, reject: false, env: baseEnv() });
  if (r.exitCode !== 0) throw new Error(`playground reset failed:\n${r.all.split('\n').slice(-25).join('\n')}`);
  return r.all;
}

export const credentials = async (user) => JSON.parse(await fs.readFile(path.join(ROOT, `tmp/test-vw-${user}.json`), 'utf8'));

// How the tool is run. host (default): the real scripts (node src/index.mjs) against the real Vaultwarden, no Docker for the
// tool itself. container: through the Docker image, to prove the packaged environment (E2E_MODE=container).
export const MODE = process.env.E2E_MODE ?? 'host';
const CA_FILE = path.join(ROOT, 'tmp/vw-tls/ca.crt');
let sevenZipBin;
async function findSevenZip() {
  if (process.env.BWBU_SEVENZIP_BIN) return process.env.BWBU_SEVENZIP_BIN;
  for (const bin of ['7z', '7zz']) if (!(await execa(bin, ['--help'], { reject: false })).failed) return bin;
  throw new Error('the host E2E needs 7-Zip (7z or 7zz), or set BWBU_SEVENZIP_BIN');
}
async function host(args) {
  sevenZipBin ??= await findSevenZip();
  const r = await execa(process.execPath, ['src/index.mjs', ...args], { cwd: ROOT, all: true, reject: false, env: { ...process.env, NODE_EXTRA_CA_CERTS: CA_FILE, BWBU_SEVENZIP_BIN: sevenZipBin } });
  if (r.exitCode !== 0) throw new Error(`bwbu ${args[0]} failed (exit ${r.exitCode}):\n${(r.all ?? '').split('\n').slice(-25).join('\n')}`);
  return r.all ?? '';
}
const creds = (user) => path.join(ROOT, `tmp/test-vw-${user}.json`);

// Backs up a test user, returns the archive name and the log.
export async function backupOf(user, { orgs = true } = {}) {
  const dir = path.join(ROOT, `tmp/backup-test-${user}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const output = MODE === 'container'
    ? await composeOk(['run', '--rm', 'bwbu-test'], { TEST_USER: user, BWBU_INCLUDE_ORG: String(orgs) })
    : await host(['backup', '--credentialsFile', creds(user), '--backupDir', dir, '--tempDir', path.join(ROOT, `tmp/e2e-work-${user}`), orgs ? '--includeOrg' : '--no-includeOrg']);
  const [archive, ...rest] = (await fs.readdir(dir)).filter((f) => f.endsWith('.7z'));
  if (!archive || rest.length) throw new Error(`expected exactly one archive in ${dir}`);
  return { archive, output };
}

// Direct mode: backs up `user` and mirrors it straight into `targetUser`, without writing an archive. Host mode only.
export async function backupDirectly(user, targetUser) {
  const dir = path.join(ROOT, `tmp/backup-test-${user}`);
  await fs.rm(dir, { recursive: true, force: true });
  return host(['backup', '--credentialsFile', creds(user), '--targetCredentialsFile', creds(targetUser), '--no-archive', '--no-includeOrg',
    '--backupDir', dir, '--tempDir', path.join(ROOT, `tmp/e2e-work-${user}`)]);
}

// Unpacks it, returns the directory with personal/ and org/.
export async function unpackOf(user, archive) {
  const unpackDir = path.join(ROOT, `tmp/unpack-test-${user}`);
  await fs.mkdir(unpackDir, { recursive: true });
  if (MODE === 'container') await composeOk(['run', '--rm', 'unpack-test'], { TEST_USER: user, E2E_ARCHIVE: archive });
  else await host(['unpack', '--credentialsFile', creds(user), '--sourceFile', path.join(ROOT, `tmp/backup-test-${user}`, archive), '--unpackDir', unpackDir]);
  return path.join(unpackDir, archive.replace(/\.7z$/, ''));
}

// Mirrors an unpacked backup into test user b, returns the log. Personal vault only unless `orgs` is set,
// `args` are extra flags such as ['--org', '<source id>=<target id>'] (host mode only).
export const mirrorInto = (sourceDir, { orgs = false, personal = true, args = [] } = {}) => MODE === 'container'
  ? composeOk(['run', '--rm', 'restore-test'], { BWBU_APPLY: 'true', RESTORE_SOURCE: sourceDir, BWBU_INCLUDE_ORG: String(orgs), BWBU_INCLUDE_PERSONAL: String(personal) })
  : host(['restore', '--credentialsFile', creds('b'), '--sourceDir', sourceDir, '--apply', orgs ? '--includeOrg' : '--no-includeOrg', personal ? '--includePersonal' : '--no-includePersonal', ...args]);

// Organizations cannot be created with the bw CLI, so the tests create them through the API (as the seeder does).
export async function createOrg(user, name) {
  const c = await credentials(user);
  const client = vwClient({ base: c.serverUrl, ca: await fs.readFile(CA_FILE) });
  return client.createOrganization({ email: c.email, password: c.masterPassword }, name);
}

// Talk to a test account with the real bw CLI, to change or inspect it directly. One logged-in session per user is
// kept for the whole suite (login and unlock cost ~15 s), each use only syncs first. Call closeBw() at the end.
const sessions = new Map();
async function openBw(user) {
  const c = await credentials(user);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bwbu-e2e-'));
  const env = { NODE_EXTRA_CA_CERTS: path.join(ROOT, 'tmp/vw-tls/ca.crt'), BITWARDENCLI_APPDATA_DIR: path.join(tmp, 'app'), BW_NOINTERACTION: 'true', BW_CLIENTID: c.clientId, BW_CLIENTSECRET: c.clientSecret };
  let session;
  const run = async (args, { input, env: extra } = {}) => (await execa(process.execPath, [BW_SCRIPT, ...args], { env: { ...env, ...(session && { BW_SESSION: session }), ...extra }, input })).stdout;
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  await run(['config', 'server', c.serverUrl]);
  await run(['login', '--apikey']);
  session = (await run(['unlock', '--raw', '--passwordenv', 'BW_PASSWORD'], { env: { BW_PASSWORD: c.masterPassword } })).trim();
  const bw = {
    run,
    json: async (args, input) => JSON.parse(await run(args, { input })),
    items: (opts = {}) => bw.json(['list', 'items', ...(opts.trash ? ['--trash'] : [])]),
    orgItems: (orgId, opts = {}) => bw.json(['list', 'items', '--organizationid', orgId, ...(opts.trash ? ['--trash'] : [])]),
    collections: (orgId) => bw.json(['list', 'org-collections', '--organizationid', orgId]),
    edit: (item) => run(['edit', 'item', item.id], { input: enc(item) }),
    create: (item) => bw.json(['create', 'item'], enc(item)),
    attach: async (itemId, fileName, content) => {
      const dir = await fs.mkdtemp(path.join(tmp, 'att-'));
      await fs.writeFile(path.join(dir, fileName), content);
      return bw.json(['create', 'attachment', '--file', path.join(dir, fileName), '--itemid', itemId]);
    },
  };
  return { bw, close: async () => { await run(['logout']).catch(() => {}); await fs.rm(tmp, { recursive: true, force: true }); } };
}

export async function withBw(user, fn) {
  const first = !sessions.has(user);
  if (first) sessions.set(user, openBw(user));
  const { bw } = await sessions.get(user);
  if (!first) await bw.run(['sync']); // other clients changed the account since the last use (a fresh login syncs by itself)
  return fn(bw);
}

export async function closeBw() {
  for (const opened of sessions.values()) await (await opened).close();
  sessions.clear();
}
