// Seeds a TEST account on the playground Vaultwarden with awkward-but-realistic data, via the real `bw` CLI
// (organizations are created through the API, the CLI cannot). Writes a manifest with what it created, including the
// sha256 of every attachment, so a restore can be verified later.
import { execa } from 'execa';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BW_SCRIPT = fileURLToPath(new URL('../../node_modules/@bitwarden/cli/build/bw.js', import.meta.url));
const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Deterministic file content of exactly `size` bytes (a fixed repeating text), so runs are reproducible.
const fileContent = (name, size) => Buffer.from(`seed:${name}\n`.repeat(Math.ceil(size / (6 + name.length)) + 1)).subarray(0, size);

export async function seedAccount({ client, user, creds, base, caFile, root, log }) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'bwbu-seed-'));
  await fs.chmod(work, 0o700);
  const env = {
    NODE_EXTRA_CA_CERTS: caFile, BITWARDENCLI_APPDATA_DIR: path.join(work, 'appdata'), BW_NOINTERACTION: 'true',
    BW_CLIENTID: creds.clientId, BW_CLIENTSECRET: creds.clientSecret,
  };
  let session;
  async function bw(args, extraEnv = {}) {
    try {
      const { stdout } = await execa(process.execPath, [BW_SCRIPT, ...args], { env: { ...env, ...(session && { BW_SESSION: session }), ...extraEnv } });
      return stdout;
    } catch (err) {
      const line = (err.stderr ?? '').split('\n').find((l) => /\w*Error:|rror/.test(l)) ?? err.shortMessage;
      throw new Error(`bw ${args.slice(0, 2).join(' ')} failed: ${line.replace(/(https?:\/\/[^\s?]+)\?\S*/g, '$1')}`.slice(0, 300));
    }
  }
  const json = async (args) => JSON.parse(await bw(args));
  const manifest = { createdAt: new Date().toISOString(), personal: { folders: [], items: [] }, orgs: [] };

  try {
    // 1. organizations first (API), so that the CLI's first sync already knows them
    const orgs = [];
    for (const name of ['Playground Org', 'Playground Org']) { // twice on purpose: same-named organizations
      const org = await client.createOrganization(user, name);
      orgs.push(org);
      log(`  created organization "${name}" (${org.id})`);
    }

    // 2. log the CLI in
    await bw(['config', 'server', base]);
    await bw(['login', '--apikey']);
    session = (await bw(['unlock', '--raw', '--passwordenv', 'BW_PASSWORD'], { BW_PASSWORD: user.password })).trim();
    await bw(['sync']);

    async function attach(itemId, fileName, size) {
      const content = fileContent(fileName, size);
      const file = path.join(work, `${crypto.randomUUID()}-${fileName}`);
      await fs.writeFile(file, content);
      // bw takes the attachment's name from the file path, so give it a directory of its own
      const dir = await fs.mkdtemp(path.join(work, 'att-'));
      const named = path.join(dir, fileName);
      await fs.rename(file, named);
      await bw(['create', 'attachment', '--file', named, '--itemid', itemId]);
      return { fileName, size, sha256: sha256(content) };
    }
    async function createItem(item, attachments = []) {
      const created = JSON.parse(await bw(['create', 'item', enc(item)]));
      const done = [];
      for (const [fileName, size] of attachments) done.push(await attach(created.id, fileName, size));
      return { id: created.id, name: item.name, type: item.type, attachments: done };
    }
    const login = (name, extra = {}) => ({ type: 1, name, notes: null, favorite: false, fields: [], login: { username: `${name.length}@example.test`, password: `pw-${name.length}`, totp: null, uris: [{ match: null, uri: 'https://example.test' }] }, ...extra });

    // 3. personal vault
    const folder = JSON.parse(await bw(['create', 'folder', enc({ name: 'Playground folder' })]));
    manifest.personal.folders.push({ id: folder.id, name: folder.name });
    const P = manifest.personal.items;
    const withTotp = login('Personal login', { folderId: folder.id, notes: 'Some notes\nsecond line', fields: [{ name: 'Field A', value: 'value A', type: 0 }] });
    withTotp.login.totp = 'JBSWY3DPEHPK3PXP';
    P.push(await createItem(withTotp));
    P.push(await createItem(login('Shared name', { folderId: folder.id }), [['personal-shared.txt', 2048]]));
    P.push(await createItem(login('Tiny attachment'), [['tiny.txt', 12]]));
    P.push(await createItem(login('Two files'), [['first.bin', 40_000], ['second.txt', 300]]));
    P.push(await createItem(login('odd/name: with?chars 🔑'), [['odd.txt', 500]]));
    P.push(await createItem({ type: 2, name: 'A secure note', notes: 'secret note', favorite: false, fields: [], secureNote: { type: 0 } }));
    P.push(await createItem({ type: 3, name: 'A card', notes: null, favorite: false, fields: [], card: { cardholderName: 'Test Person', brand: 'Visa', number: '4111111111111111', expMonth: '12', expYear: '2031', code: '123' } }));
    P.push(await createItem(login('Plain login')));
    log(`  personal: ${P.length} items, ${P.reduce((n, i) => n + i.attachments.length, 0)} attachments`);

    // 4. organizations
    await bw(['sync']);
    for (const [index, org] of orgs.entries()) {
      const collections = await json(['list', 'org-collections', '--organizationid', org.id]);
      const manifestOrg = { id: org.id, name: org.name, collections: collections.map((c) => ({ id: c.id, name: c.name })), items: [] };
      let second = null;
      if (index === 0) {
        second = JSON.parse(await bw(['create', 'org-collection', enc({ organizationId: org.id, name: 'Second collection', externalId: null, groups: [] }), '--organizationid', org.id]));
        manifestOrg.collections.push({ id: second.id, name: 'Second collection' });
      }
      const inOrg = (item, ...collectionIds) => ({ ...item, organizationId: org.id, collectionIds });
      const defaultCollection = collections[0].id;
      if (index === 0) {
        manifestOrg.items.push(await createItem(inOrg(login('Shared name'), defaultCollection), [['org-shared.txt', 1024]])); // same name as a personal item
        manifestOrg.items.push(await createItem(inOrg(login('Org login'), second.id)));
        manifestOrg.items.push(await createItem(inOrg(login('Org two files'), defaultCollection, second.id), [['org-a.bin', 5000], ['org-b.txt', 200]]));
      } else {
        manifestOrg.items.push(await createItem(inOrg(login('Other org item'), defaultCollection), [['other.txt', 700]]));
      }
      manifest.orgs.push(manifestOrg);
      log(`  org #${index + 1}: ${manifestOrg.items.length} items, ${manifestOrg.items.reduce((n, i) => n + i.attachments.length, 0)} attachments, ${manifestOrg.collections.length} collection(s)`);
    }
    await bw(['logout']).catch(() => {});
    return manifest;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
