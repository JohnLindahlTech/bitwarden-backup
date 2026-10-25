import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { MARKER, readMarkers } from '../src/mirror.mjs';
import { restore } from '../src/restore.mjs';
import { makeSandbox } from '../testing/helpers.mjs';

const login = (id, name, extra = {}) => ({ id, type: 1, name, notes: null, folderId: null, favorite: false, fields: [], login: { username: 'u', password: `pw-${name}`, uris: [{ uri: 'https://x.test' }] }, attachments: [], ...extra });
const att = (id, fileName) => ({ id, fileName });
const FOLDERS = [{ id: null, name: 'No Folder' }, { id: 'sf1', name: 'Folder' }];

// A backup directory on disk + a fake target account (a JSON file) that starts as given.
async function world(initialTarget = { items: [], folders: [] }) {
  const sb = await makeSandbox();
  const dir = path.join(sb.dir, 'backup');
  const state = path.join(sb.dir, 'target.json');
  await fs.writeFile(state, JSON.stringify({ seq: 0, ...initialTarget }));
  process.env.FAKE_BW_STATE = state;
  const w = {
    sb, dir,
    // (re)write the backup as the source vault looks right now
    async source(items, folders = FOLDERS) {
      await fs.rm(path.join(dir, 'personal'), { recursive: true, force: true });
      await fs.mkdir(path.join(dir, 'personal'), { recursive: true });
      await fs.writeFile(path.join(dir, 'personal', 'items.json'), JSON.stringify(items));
      await fs.writeFile(path.join(dir, 'personal', 'folders.json'), JSON.stringify(folders));
      await fs.writeFile(path.join(dir, 'personal', 'export.json'), JSON.stringify({ folders: folders.filter((f) => f.id), items: items.map(({ attachments, ...i }) => i) }));
      for (const item of items) for (const a of item.attachments) {
        const d = path.join(dir, 'personal', 'attachments', item.name, item.id, a.id);
        await fs.mkdir(d, { recursive: true });
        await fs.writeFile(path.join(d, a.fileName), `content ${a.id}`);
      }
    },
    argv: (extra = {}) => ({ credentialsFile: sb.credentialsFile, sourceDir: dir, apply: true, ...extra }),
    run: (extra) => restore(w.argv(extra), sb.deps),
    target: async () => JSON.parse(await fs.readFile(state, 'utf8')),
    live: async () => (await w.target()).items.filter((i) => !i.deletedDate),
    // bw commands issued since the last call of this function
    seen: 0,
    async newCalls() { const all = (await sb.bwCalls()).map((c) => c.args); const fresh = all.slice(w.seen); w.seen = all.length; return fresh; },
    changes: (calls) => calls.filter((a) => ['import', 'create', 'edit', 'delete', 'restore'].includes(a[0])).map((a) => a.slice(0, 2).join(' ')),
  };
  return w;
}

test('dry run logs in, plans, and changes nothing', async () => {
  const w = await world();
  await w.source([login('s1', 'A')]);
  await w.run({ apply: false });
  assert.deepEqual(w.changes(await w.newCalls()), []);
  assert.equal((await w.target()).items.length, 0);
  await w.sb.cleanup();
});

test('an empty target gets one bulk import with markers, then the attachments, and its folders', async () => {
  const w = await world();
  await w.source([login('s1', 'A', { folderId: 'sf1', attachments: [att('a1', 'one.txt')] }), login('s2', 'B', { attachments: [att('a2', 'x.txt'), att('a3', 'y.txt')] }), login('s3', 'C')]);
  await w.run();
  const calls = await w.newCalls();
  assert.equal(calls.filter((a) => a[0] === 'import').length, 1);
  assert.equal(calls.filter((a) => a[0] === 'create' && a[1] === 'item').length, 0); // not one by one
  const items = await w.live();
  assert.deepEqual(items.map((i) => readMarkers(i).src).sort(), ['s1', 's2', 's3']);
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal((await w.target()).folders.find((f) => f.id === byName.A.folderId).name, 'Folder');
  assert.deepEqual(byName.B.attachments.map((a) => a.fileName), ['x.txt', 'y.txt']);
  assert.deepEqual(readMarkers(byName.B).attachments.map((m) => m.i), ['a2', 'a3']); // source id -> target id recorded
  assert.deepEqual(byName.B.attachments.map((a) => a.id), readMarkers(byName.B).attachments.map((m) => m.t));
  await w.sb.cleanup();
});

test('repeating the run changes nothing at all', async () => {
  const w = await world();
  await w.source([login('s1', 'A', { attachments: [att('a1', 'one.txt')] }), login('s2', 'B', { folderId: 'sf1' })]);
  await w.run();
  const first = await w.target();
  await w.newCalls();
  await w.run();
  assert.deepEqual(w.changes(await w.newCalls()), []);
  assert.deepEqual(await w.target(), first);
  await w.sb.cleanup();
});

test('a changed item is edited, a new one created, unchanged ones are not touched', async () => {
  const w = await world();
  await w.source([login('s1', 'A'), login('s2', 'B')]);
  await w.run();
  await w.newCalls();
  await w.source([login('s1', 'A', { login: { username: 'u', password: 'new password', uris: [{ uri: 'https://x.test' }] } }), login('s2', 'B'), login('s3', 'New')]);
  await w.run();
  assert.deepEqual(w.changes(await w.newCalls()).sort(), ['create item', 'edit item']);
  const byName = Object.fromEntries((await w.live()).map((i) => [i.name, i]));
  assert.equal(byName.A.login.password, 'new password');
  assert.equal(readMarkers(byName.A).src, 's1'); // the marker survived the edit
  await w.sb.cleanup();
});

test('items gone from the backup go to the trash (never deleted), unless --removed keep', async () => {
  const w = await world();
  await w.source([login('s1', 'A'), login('s2', 'B')]);
  await w.run();
  await w.source([login('s1', 'A')]);
  await w.run({ removed: 'keep' });
  assert.equal((await w.live()).length, 2);
  await w.run();
  assert.deepEqual((await w.live()).map((i) => i.name), ['A']);
  assert.equal((await w.target()).items.length, 2); // still there, in the trash
  await w.sb.cleanup();
});

test('an item that comes back is restored from the trash, not duplicated', async () => {
  const w = await world();
  await w.source([login('s1', 'A'), login('s2', 'B')]);
  await w.run();
  await w.source([login('s1', 'A')]);
  await w.run();
  await w.newCalls();
  await w.source([login('s1', 'A'), login('s2', 'B')]);
  await w.run();
  assert.ok(w.changes(await w.newCalls()).includes('restore item'));
  assert.equal((await w.target()).items.length, 2);
  assert.equal((await w.live()).length, 2);
  await w.sb.cleanup();
});

test('attachments added to or removed from the source follow, and only those', async () => {
  const w = await world();
  await w.source([login('s1', 'A', { attachments: [att('a1', 'one.txt'), att('a2', 'two.txt')] })]);
  await w.run();
  await w.newCalls();
  await w.source([login('s1', 'A', { attachments: [att('a2', 'two.txt'), att('a3', 'three.txt')] })]);
  await w.run();
  const calls = await w.newCalls();
  assert.equal(calls.filter((a) => a[0] === 'delete' && a[1] === 'attachment').length, 1);
  assert.equal(calls.filter((a) => a[0] === 'create' && a[1] === 'attachment').length, 1);
  const [item] = await w.live();
  assert.deepEqual(item.attachments.map((a) => a.fileName).sort(), ['three.txt', 'two.txt']);
  assert.deepEqual(readMarkers(item).attachments.map((m) => m.i).sort(), ['a2', 'a3']);
  await w.sb.cleanup();
});

test('a populated target: items that are not ours are left alone and reported', async () => {
  const w = await world({ items: [{ id: 'mine1', type: 1, name: 'My own login', fields: [], attachments: [], deletedDate: null }], folders: [] });
  await w.source([login('s1', 'A')]);
  await w.run();
  const items = (await w.target()).items;
  assert.deepEqual(items.find((i) => i.id === 'mine1'), { id: 'mine1', type: 1, name: 'My own login', fields: [], attachments: [], deletedDate: null });
  assert.equal(items.length, 2);
  assert.equal((await w.target()).imports ?? 0, 0); // not empty, so no bulk import
  await w.sb.cleanup();
});

test('a failed attachment upload fails the run, and the next run retries only that one', async () => {
  const w = await world();
  await w.source([login('s1', 'A', { attachments: [att('a1', 'one.txt'), att('a2', 'two.txt')] })]);
  process.env.FAKE_BW_FAIL_ATTACH = 'a1';
  await assert.rejects(w.run(), /incompletely.*a1/s);
  let [item] = await w.live();
  assert.deepEqual(readMarkers(item).attachments.map((m) => m.i), ['a2']); // the good one is recorded, the failed one is not
  delete process.env.FAKE_BW_FAIL_ATTACH;
  await w.newCalls();
  await w.run();
  assert.equal((await w.newCalls()).filter((a) => a[0] === 'create' && a[1] === 'attachment').length, 1);
  [item] = await w.live();
  assert.deepEqual(readMarkers(item).attachments.map((m) => m.i).sort(), ['a1', 'a2']);
  await w.sb.cleanup();
});

test('items are sent on stdin, never as command line arguments', async () => {
  const w = await world({ items: [{ id: 'x', type: 1, name: 'Existing', fields: [], attachments: [], deletedDate: null }], folders: [] });
  await w.source([login('s1', 'A')]);
  await w.run();
  const argv = (await w.sb.bwCalls()).flatMap((c) => c.args).join(' ');
  assert.doesNotMatch(argv, /pw-A|master-pw|client-secret|SESSIONKEY/);
  await w.sb.cleanup();
});

test('needs exactly one source and a valid --removed', async () => {
  const w = await world();
  await w.source([login('s1', 'A')]);
  await assert.rejects(w.run({ sourceDir: undefined }), /exactly one of/);
  await assert.rejects(w.run({ sourceFile: '/x.7z' }), /exactly one of/);
  await assert.rejects(w.run({ removed: 'purge' }), /--removed/);
  await w.sb.cleanup();
});
