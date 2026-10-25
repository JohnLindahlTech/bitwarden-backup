// End-to-end: the real scripts against a real (throwaway) Vaultwarden, from a fresh reset.
//   npm run e2e        (needs Docker for Vaultwarden; about 15 minutes, most of it is the bw CLI doing one request at a time)
// The tests build on each other, in order: backup -> mirror -> change the source -> mirror again -> organizations.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { verify } from '../scripts/verify-against-seed.mjs';
import { readMarkers } from '../src/mirror.mjs';
import { ROOT, backupDirectly, backupOf, closeBw, createOrg, mirrorInto, resetPlayground, unpackOf, withBw } from './helpers.mjs';

const SLOW = { timeout: 20 * 60 * 1000 };
const failures = (checks) => checks.filter((c) => !c.ok).map((c) => `${c.label} (${c.detail})`);
const summary = (log) => log.match(/Mirrored: (\d+) created, (\d+) updated, (\d+) restored from trash, (\d+) moved to trash; attachments \+(\d+) -(\d+)/)?.slice(1).map(Number);
// The plan line of a vault: [create, update, unchanged, restore from trash, move to trash, attachments +, attachments -, not ours]
const PLAN = 'create (\\d+), update (\\d+), unchanged (\\d+), restore from trash (\\d+), move to trash (\\d+); attachments \\+(\\d+) -(\\d+); items on the target that are not ours \\(never touched\\): (\\d+)';
const plan = (log, label = 'personal vault') => log.match(new RegExp(`${label}: ${PLAN}`))?.slice(1).map(Number);
const orgPlans = (log) => [...log.matchAll(new RegExp(`org "Playground Org": ${PLAN}`, 'g'))].map((m) => m.slice(1).map(Number)); // one per mirrored organization, in backup order
let sourceDir; // the unpacked source the mirror reads: the latest backup of user a, later copies of it with edits
let firstBackupDir; // the unpacked first backup of a, as it was seeded

before(async () => { await resetPlayground(); }, { timeout: 30 * 60 * 1000 }); // fresh Vaultwarden, two users, a is seeded
after(async () => { await closeBw(); });

async function backupAndUnpackA({ orgs = false } = {}) {
  const { archive, output } = await backupOf('a', { orgs });
  assert.doesNotMatch(output, /\[(ERROR|WARN)\]/, 'the backup logged errors or warnings');
  sourceDir = await unpackOf('a', archive);
  return sourceDir;
}

test('1. the backup of the seeded account is complete (items, folders, every attachment byte for byte, both orgs)', SLOW, async () => {
  const dir = await backupAndUnpackA({ orgs: true });
  firstBackupDir = dir;
  assert.deepEqual(failures(await verify(dir)), []);
});

test('2. the first mirror into the empty account b imports everything, and b backs up identically', SLOW, async () => {
  const log = await mirrorInto(sourceDir);
  assert.deepEqual(summary(log), [8, 0, 0, 0, 5, 0]); // 8 items, 5 attachments
  assert.match(log, /personal vault: target is empty, bulk importing 8 items/);

  const { archive } = await backupOf('b');
  assert.deepEqual(failures(await verify(await unpackOf('b', archive), { personalOnly: true })), []);
});

test('3. mirroring again changes nothing', SLOW, async () => {
  const log = await mirrorInto(sourceDir);
  assert.deepEqual(plan(log), [0, 0, 8, 0, 0, 0, 0, 0]); // everything unchanged
  assert.deepEqual(summary(log), [0, 0, 0, 0, 0, 0]);
});

test('4. changes in the source follow: edit, new item with attachment, trash, attachments swapped', SLOW, async () => {
  await withBw('a', async (a) => {
    const items = await a.items();
    const byName = (n) => items.find((i) => i.name === n);
    const plain = byName('Plain login');
    plain.login.password = 'changed-password-123';
    await a.edit(plain);
    const added = await a.create({ type: 1, name: 'Added later', notes: 'new item', favorite: false, fields: [], login: { username: 'new@example.test', password: 'pw-new', uris: [{ uri: 'https://new.example.test' }] } });
    await a.attach(added.id, 'later.txt', 'attachment added later');
    await a.run(['delete', 'item', byName('A card').id]);
    const two = byName('Two files');
    await a.run(['delete', 'attachment', two.attachments.find((x) => x.fileName === 'second.txt').id, '--itemid', two.id]);
    await a.attach(two.id, 'third.txt', 'third attachment');
  });
  await backupAndUnpackA();
  const log = await mirrorInto(sourceDir);
  assert.deepEqual(plan(log), [1, 1, 5, 0, 1, 2, 1, 0]);
  assert.deepEqual(summary(log), [1, 1, 0, 1, 2, 1]);

  await withBw('b', async (b) => {
    const live = await b.items();
    const item = (n) => live.find((i) => i.name === n);
    assert.equal(live.length, 8);
    assert.deepEqual((await b.items({ trash: true })).map((i) => i.name), ['A card']); // trashed, not deleted
    assert.equal(item('Plain login').login.password, 'changed-password-123');
    assert.equal(item('Plain login').passwordHistory.length, 1); // Bitwarden kept the old password
    assert.deepEqual(item('Two files').attachments.map((x) => x.fileName).sort(), ['first.bin', 'third.txt']);
    assert.deepEqual(item('Added later').attachments.map((x) => x.fileName), ['later.txt']);
    // the user's own data survives the mirroring
    assert.ok(item('Personal login').fields.some((f) => f.name === 'Field A' && f.value === 'value A'));
    assert.equal(item('Personal login').login.totp, 'JBSWY3DPEHPK3PXP');
    assert.equal(readMarkers(item('Two files')).attachments.length, 2);
  });
});

// Tests 5 to 7 are about the mirror against a real server, not about how the backup came about, so they change
// copies of the unpacked backup on disk instead of changing `a` and backing it up again (minutes cheaper).
const personal = (dir, file) => path.join(dir, 'personal', file);
async function editSource(dir, mutate) {
  const copy = `${dir}-edited-${Date.now()}`;
  await fs.cp(dir, copy, { recursive: true });
  for (const file of ['items.json', 'export.json']) {
    const data = JSON.parse(await fs.readFile(personal(copy, file), 'utf8'));
    const items = Array.isArray(data) ? data : data.items;
    const edited = mutate(items);
    await fs.writeFile(personal(copy, file), JSON.stringify(Array.isArray(data) ? edited : { ...data, items: edited }));
  }
  return copy;
}

test('5. an item that returns to the backup comes back from the trash, it is not duplicated', SLOW, async () => {
  const card = JSON.parse(await fs.readFile(personal(firstBackupDir, 'items.json'), 'utf8')).find((i) => i.name === 'A card');
  sourceDir = await editSource(sourceDir, (items) => [...items, card]); // the card is back in the source
  const log = await mirrorInto(sourceDir);
  assert.deepEqual(plan(log), [0, 0, 8, 1, 0, 0, 0, 0]);
  await withBw('b', async (b) => {
    const live = await b.items();
    assert.equal(live.filter((i) => i.name === 'A card').length, 1);
    assert.equal((await b.items({ trash: true })).length, 0);
    assert.equal(live.length, 9);
  });
});

test('6. items on the target that the tool did not create are left alone, removals still trash only mirrored items', SLOW, async () => {
  const handmade = await withBw('b', (b) => b.create({ type: 1, name: 'Hand-made on b', notes: null, favorite: false, fields: [], login: { username: 'me', password: 'mine', uris: [] } }));
  sourceDir = await editSource(sourceDir, (items) => items.filter((i) => i.name !== 'Tiny attachment')); // removed from the source
  const log = await mirrorInto(sourceDir);
  assert.deepEqual(plan(log), [0, 0, 8, 0, 1, 0, 0, 1]); // one item to the trash (its attachments stay with it), one item that is not ours
  assert.match(log, /1 item\(s\) on the target were not created by this tool/);
  await withBw('b', async (b) => {
    const live = await b.items();
    assert.ok(live.some((i) => i.id === handmade.id && i.login.password === 'mine'));
    assert.deepEqual((await b.items({ trash: true })).map((i) => i.name), ['Tiny attachment']);
  });
});

test('7. and once more everything is converged, nothing is changed', SLOW, async () => {
  const log = await mirrorInto(sourceDir);
  assert.deepEqual(plan(log), [0, 0, 8, 0, 0, 0, 0, 1]);
  assert.deepEqual(summary(log), [0, 0, 0, 0, 0, 0]);
});

// ---- organizations (tests 8 to 11 only need test 1: they read the unpacked first backup of a, which has both orgs) ----
const hashOf = (buf) => createHash('sha256').update(buf).digest('hex');
async function hashes(dir) {
  const out = [];
  const walk = async (d) => { for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) { const p = path.join(d, e.name); e.isDirectory() ? await walk(p) : out.push(hashOf(await fs.readFile(p))); } };
  await walk(dir);
  return out.sort();
}
const sourceOrgs = async (dir) => Promise.all((await readJson(dir, 'org', 'list.json')).map(async (o) => ({ ...o, dir: path.join(dir, 'org', o.name, o.id) })));
const readJson = async (...p) => JSON.parse(await fs.readFile(path.join(...p), 'utf8'));
let backedUp; // [{ id, name, dir }] the two organizations of the first backup of a
let targets; // the two same-named organizations created for b

test('8. same-named organizations are not guessed: reported loudly, the run succeeds, nothing is written', SLOW, async () => {
  backedUp = await sourceOrgs(firstBackupDir);
  targets = [await createOrg('b', 'Playground Org'), await createOrg('b', 'Playground Org')];
  const log = await mirrorInto(firstBackupDir, { orgs: true, personal: false });
  assert.equal([...log.matchAll(/was NOT mirrored: .*choose with --org/g)].length, 2);
  assert.match(log, /WARNING: 2 organization\(s\) were NOT mirrored/);
  await withBw('b', async (b) => {
    for (const t of targets) assert.equal((await b.orgItems(t.id)).length, 0);
  });
});

test('9. --org maps them: items, collections (reused, not duplicated), attachments byte for byte', SLOW, async () => {
  const log = await mirrorInto(firstBackupDir, { orgs: true, personal: false, args: ['--org', `${backedUp[0].id}=${targets[0].id}`, '--org', `${backedUp[1].id}=${targets[1].id}`] });
  assert.deepEqual(orgPlans(log), [[3, 0, 0, 0, 0, 3, 0, 0], [1, 0, 0, 0, 0, 1, 0, 0]]);
  assert.deepEqual(summary(log), [4, 0, 0, 0, 4, 0]);
  assert.doesNotMatch(log, /NOT mirrored/);

  // what b now backs up must equal what was seeded into a, organization by organization
  const manifest = await readJson(ROOT, 'tmp', 'test-vw-a.seed.json');
  const { archive } = await backupOf('b');
  const unpacked = await unpackOf('b', archive);
  for (const [i, target] of targets.entries()) {
    const seeded = manifest.orgs.find((o) => o.id === backedUp[i].id);
    const dir = path.join(unpacked, 'org', 'Playground Org', target.id);
    assert.deepEqual(await hashes(path.join(dir, 'attachments')), seeded.items.flatMap((x) => x.attachments.map((a) => a.sha256)).sort(), `attachments of organization ${i + 1}`);
    assert.equal((await readJson(dir, 'items.json')).length, seeded.items.length);
    const names = (await readJson(dir, 'collections.json')).map((c) => c.name).sort();
    assert.deepEqual(names, seeded.collections.map((c) => c.name).sort(), `collections of organization ${i + 1}`); // "Default collection" exists once
  }
});

test('10. mirroring the organizations again needs no flags (the markers say where everything goes) and changes nothing', SLOW, async () => {
  const log = await mirrorInto(firstBackupDir, { orgs: true, personal: false });
  assert.doesNotMatch(log, /NOT mirrored/);
  assert.deepEqual(orgPlans(log), [[0, 0, 3, 0, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0, 0, 0]]);
  assert.deepEqual(summary(log), [0, 0, 0, 0, 0, 0]);
});

test('11. organization changes follow: edit, move between collections, new item, removal to the trash', SLOW, async () => {
  const copy = `${firstBackupDir}-orgedit-${Date.now()}`;
  await fs.cp(firstBackupDir, copy, { recursive: true });
  const dir = path.join(copy, 'org', 'Playground Org', backedUp[0].id);
  const collections = await readJson(dir, 'collections.json');
  const id = (name) => collections.find((c) => c.name === name).id;
  const items = await readJson(dir, 'items.json');
  const by = (n) => items.find((i) => i.name === n);
  by('Org login').login.password = 'pw-changed';
  by('Shared name').collectionIds = [id('Second collection')]; // was in the default collection
  const edited = [...items.filter((i) => i.name !== 'Org two files'), { ...by('Org login'), id: 'e2e-new-item', name: 'Org new', collectionIds: [id('Default collection')], attachments: [], login: { ...by('Org login').login, password: 'pw-new' } }];
  await fs.writeFile(path.join(dir, 'items.json'), JSON.stringify(edited));

  const log = await mirrorInto(copy, { orgs: true, personal: false });
  assert.deepEqual(orgPlans(log), [[1, 2, 0, 0, 1, 0, 0, 0], [0, 0, 1, 0, 0, 0, 0, 0]]);
  assert.deepEqual(summary(log), [1, 2, 0, 1, 0, 0]);

  await withBw('b', async (b) => {
    const live = await b.orgItems(targets[0].id);
    const targetCollections = await b.collections(targets[0].id);
    const cid = (name) => targetCollections.find((c) => c.name === name).id;
    const item = (n) => live.find((i) => i.name === n);
    assert.deepEqual(live.map((i) => i.name).sort(), ['Org login', 'Org new', 'Shared name']);
    assert.equal(item('Org login').login.password, 'pw-changed');
    assert.deepEqual(item('Shared name').collectionIds, [cid('Second collection')]); // moved
    assert.deepEqual(item('Org new').collectionIds, [cid('Default collection')]);
    assert.deepEqual(item('Shared name').attachments.map((a) => a.fileName), ['org-shared.txt']);
    assert.deepEqual((await b.orgItems(targets[0].id, { trash: true })).map((i) => i.name), ['Org two files']); // trashed, not deleted
  });
});

test('12. direct mode: backing up a with a target and --no-archive mirrors into b and writes no archive', SLOW, async () => {
  const output = await backupDirectly('a', 'b');
  assert.match(output, /Mirrored: \d+ created, \d+ updated/);
  assert.doesNotMatch(output, /\[ERROR\]/);
  assert.deepEqual(await fs.readdir(path.join(ROOT, 'tmp', 'backup-test-a')).catch(() => []), []); // no archive was written
  await fs.access(path.join(ROOT, 'tmp', 'e2e-work-a')).then(() => assert.fail('the plaintext temp dir was left behind'), () => {});
  await withBw('b', async (b) => {
    const live = await b.items();
    assert.ok(live.length > 0 && live.every((i) => i.fields?.some((f) => f.name === 'bwbu:v1:src')), 'b holds mirrored items with markers');
  });
});
