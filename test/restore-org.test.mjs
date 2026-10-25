import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { readMarkers } from '../src/mirror.mjs';
import { restore } from '../src/restore.mjs';
import { makeSandbox } from '../testing/helpers.mjs';

const item = (id, name, extra = {}) => ({ id, type: 1, name, notes: null, favorite: false, fields: [], collectionIds: [], organizationId: 'SRC', login: { username: 'u', password: `pw-${name}`, uris: [] }, attachments: [], ...extra });
const att = (id, fileName) => ({ id, fileName });
const owner = (id, name, extra = {}) => ({ id, name, type: 0, status: 2, enabled: true, ...extra });

// A backup with organizations on disk + a fake target account with the given organizations.
async function world({ targetOrgs, collections = [], items = [] } = {}) {
  const sb = await makeSandbox();
  const dir = path.join(sb.dir, 'backup');
  const state = path.join(sb.dir, 'target.json');
  await fs.writeFile(state, JSON.stringify({ seq: 0, items, folders: [], orgs: targetOrgs, collections }));
  process.env.FAKE_BW_STATE = state;
  const w = {
    sb, dir,
    // orgs: [{ id, name, collections: [{id,name}], items }]
    async source(orgs) {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(path.join(dir, 'personal'), { recursive: true });
      for (const f of ['items', 'folders']) await fs.writeFile(path.join(dir, 'personal', `${f}.json`), '[]');
      await fs.writeFile(path.join(dir, 'personal', 'export.json'), '{"folders":[],"items":[]}');
      await fs.mkdir(path.join(dir, 'org'), { recursive: true });
      await fs.writeFile(path.join(dir, 'org', 'list.json'), JSON.stringify(orgs.map(({ id, name }) => ({ id, name }))));
      await fs.writeFile(path.join(dir, 'org', 'skipped.json'), '[]');
      for (const org of orgs) {
        const d = path.join(dir, 'org', org.name, org.id);
        await fs.mkdir(d, { recursive: true });
        await fs.writeFile(path.join(d, 'items.json'), JSON.stringify(org.items));
        await fs.writeFile(path.join(d, 'collections.json'), JSON.stringify(org.collections));
        for (const i of org.items) for (const a of i.attachments) {
          const ad = path.join(d, 'attachments', i.name, i.id, a.id);
          await fs.mkdir(ad, { recursive: true });
          await fs.writeFile(path.join(ad, a.fileName), `content ${a.id}`);
        }
      }
    },
    argv: (extra = {}) => ({ credentialsFile: sb.credentialsFile, sourceDir: dir, apply: true, ...extra }),
    run: (extra) => restore(w.argv(extra), sb.deps),
    state: async () => JSON.parse(await fs.readFile(state, 'utf8')),
    live: async (orgId) => (await w.state()).items.filter((i) => !i.deletedDate && i.organizationId === orgId),
    seen: 0,
    async newCalls() { const all = (await sb.bwCalls()).map((c) => c.args); const fresh = all.slice(w.seen); w.seen = all.length; return fresh; },
    changes: (calls) => calls.filter((a) => ['import', 'create', 'edit', 'delete', 'restore'].includes(a[0])).map((a) => a.slice(0, 2).join(' ')),
  };
  return w;
}

async function warnings(fn) {
  const out = [];
  const orig = console.warn;
  console.warn = (...a) => out.push(a.join(' '));
  process.env.LOG_LEVEL = 'warn';
  try { await fn(); } finally { console.warn = orig; process.env.LOG_LEVEL = 'error'; }
  return out.join('\n');
}

const FAMILY = (extra = []) => ({
  id: 'S1', name: 'Family', collections: [{ id: 'sc1', name: 'Default collection' }, { id: 'sc2', name: 'Second' }],
  items: [item('o1', 'Wifi', { collectionIds: ['sc1'], attachments: [att('a1', 'wifi.txt')] }), item('o2', 'Netflix', { collectionIds: ['sc1', 'sc2'] }), ...extra],
});
const target = () => ({ targetOrgs: [owner('T1', 'Family')], collections: [{ id: 'tc0', name: 'Default collection', organizationId: 'T1' }] });

test('a uniquely named organization is mirrored: items, collections (missing ones created), attachments, markers', async () => {
  const w = await world(target());
  await w.source([FAMILY()]);
  await w.run();
  const items = await w.live('T1');
  assert.deepEqual(items.map((i) => i.name).sort(), ['Netflix', 'Wifi']);
  const collections = (await w.state()).collections;
  const id = (name) => collections.find((c) => c.name === name && c.organizationId === 'T1').id;
  assert.equal(collections.filter((c) => c.name === 'Default collection').length, 1); // reused, not duplicated
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.deepEqual(byName.Netflix.collectionIds.sort(), [id('Default collection'), id('Second')].sort());
  assert.deepEqual(byName.Wifi.attachments.map((a) => a.fileName), ['wifi.txt']);
  assert.equal(readMarkers(byName.Wifi).src, 'o1');
  assert.equal(items.every((i) => i.folderId === null), true);
  await w.sb.cleanup();
});

test('repeating the run changes nothing', async () => {
  const w = await world(target());
  await w.source([FAMILY()]);
  await w.run();
  const first = await w.state();
  await w.newCalls();
  await w.run();
  assert.deepEqual(w.changes(await w.newCalls()), []);
  assert.deepEqual(await w.state(), first);
  await w.sb.cleanup();
});

test('source changes follow: edited item, new item, item moved between collections, removed item trashed', async () => {
  const w = await world(target());
  await w.source([FAMILY([item('o3', 'Gone soon', { collectionIds: ['sc1'] })])]);
  await w.run();
  await w.newCalls();
  const changed = FAMILY();
  changed.items = [
    item('o1', 'Wifi', { collectionIds: ['sc1'], attachments: [att('a1', 'wifi.txt')], login: { username: 'u', password: 'new', uris: [] } }),
    item('o2', 'Netflix', { collectionIds: ['sc2'] }), // moved out of the default collection
    item('o4', 'Fresh', { collectionIds: ['sc2'] }),
  ];
  await w.source([changed]);
  await w.run();
  const calls = await w.newCalls();
  assert.deepEqual(w.changes(calls).sort(), ['create item', 'delete item', 'edit item', 'edit item', 'edit item-collections']);
  assert.equal(calls.filter((a) => a[0] === 'edit' && a[1] === 'item-collections').length, 1);
  const items = await w.live('T1');
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.deepEqual(Object.keys(byName).sort(), ['Fresh', 'Netflix', 'Wifi']);
  assert.equal(byName.Wifi.login.password, 'new');
  assert.equal(byName.Netflix.collectionIds.length, 1);
  assert.equal((await w.state()).items.filter((i) => i.deletedDate).map((i) => i.name).join(), 'Gone soon'); // trashed, not deleted
  await w.sb.cleanup();
});

test('same-named organizations are not guessed: reported loudly, the run still succeeds', async () => {
  const w = await world({ targetOrgs: [owner('T1', 'Org'), owner('T2', 'Org')] });
  await w.source([{ id: 'S1', name: 'Org', collections: [{ id: 'c', name: 'Default collection' }], items: [item('o1', 'One', { collectionIds: ['c'] })] }, { id: 'S2', name: 'Org', collections: [{ id: 'c2', name: 'Default collection' }], items: [item('o2', 'Two', { collectionIds: ['c2'] })] }]);
  const warned = await warnings(() => w.run());
  assert.match(warned, /Organization "Org" \(S1\) was NOT mirrored: .*choose with --org/);
  assert.match(warned, /\(S2\) was NOT mirrored/);
  assert.match(warned, /WARNING: 2 organization\(s\) were NOT mirrored/);
  assert.equal((await w.state()).items.length, 0);
  await w.sb.cleanup();
});

test('--org maps same-named organizations, and later runs find them again through the markers', async () => {
  const w = await world({ targetOrgs: [owner('T1', 'Org'), owner('T2', 'Org')], collections: [{ id: 'k1', name: 'Default collection', organizationId: 'T1' }, { id: 'k2', name: 'Default collection', organizationId: 'T2' }] });
  const org = (id, name, itemId, itemName, c) => ({ id, name, collections: [{ id: c, name: 'Default collection' }], items: [item(itemId, itemName, { collectionIds: [c] })] });
  await w.source([org('S1', 'Org', 'o1', 'One', 'c1'), org('S2', 'Org', 'o2', 'Two', 'c2')]);
  await w.run({ org: ['S1=T2', 'S2=T1'] }); // deliberately crossed
  assert.deepEqual((await w.live('T2')).map((i) => i.name), ['One']);
  assert.deepEqual((await w.live('T1')).map((i) => i.name), ['Two']);
  await w.newCalls();
  const warned = await warnings(() => w.run()); // no flags this time: the markers say where everything goes
  assert.doesNotMatch(warned, /NOT mirrored/);
  assert.deepEqual(w.changes(await w.newCalls()), []);
  await w.sb.cleanup();
});

test('--org must be <id>=<id>, and cannot point at an organization we may not write to', async () => {
  const w = await world({ targetOrgs: [owner('T1', 'Family'), owner('M', 'Member org', { type: 2 })], collections: [] });
  await w.source([FAMILY()]);
  await assert.rejects(w.run({ org: ['nonsense'] }), /expects <backed-up org id>=<target org id>/);
  const warned = await warnings(() => w.run({ org: ['S1=M'] }));
  assert.match(warned, /not an organization you can write to/);
  assert.equal((await w.state()).items.length, 0);
  await w.sb.cleanup();
});

test('a dry run plans the organization and changes nothing', async () => {
  const w = await world(target());
  await w.source([FAMILY()]);
  await w.run({ apply: false });
  assert.deepEqual(w.changes(await w.newCalls()), []);
  assert.equal((await w.state()).items.length, 0);
  await w.sb.cleanup();
});

test('organization items are never mirrored into the personal vault, and --no-includeOrg skips organizations', async () => {
  const w = await world({ ...target(), items: [{ id: 'x', name: 'Some org item', organizationId: 'T1', fields: [], attachments: [], deletedDate: null }] });
  await w.source([FAMILY()]);
  await w.run({ includeOrg: false });
  assert.equal((await w.live('T1')).length, 1); // only the one that was already there
  await w.sb.cleanup();
});
