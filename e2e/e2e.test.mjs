// End-to-end: the real Docker image against a real (throwaway) Vaultwarden, from a fresh reset.
//   npm run e2e        (needs Docker; takes ~15 minutes, most of it is the bw CLI doing one request at a time)
// The tests build on each other, in order: backup -> mirror -> change the source -> mirror again.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { verify } from '../scripts/verify-against-seed.mjs';
import { readMarkers } from '../src/mirror.mjs';
import { backupOf, closeBw, mirrorInto, resetPlayground, unpackOf, withBw } from './helpers.mjs';

const SLOW = { timeout: 20 * 60 * 1000 };
const failures = (checks) => checks.filter((c) => !c.ok).map((c) => `${c.label} (${c.detail})`);
const summary = (log) => log.match(/Mirrored: (\d+) created, (\d+) updated, (\d+) restored from trash, (\d+) moved to trash; attachments \+(\d+) -(\d+)/)?.slice(1).map(Number);
const plan = (log) => log.match(/Plan: create (\d+), update (\d+), unchanged (\d+), restore from trash (\d+), move to trash (\d+); attachments \+(\d+) -(\d+); items on the target that are not ours \(never touched\): (\d+)/)?.slice(1).map(Number);
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
  assert.match(log, /Target is empty: bulk importing 8 items/);

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
