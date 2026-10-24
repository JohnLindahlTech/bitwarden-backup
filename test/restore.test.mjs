import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { matchItems, restore } from '../src/restore.mjs';
import { makeSandbox } from '../testing/helpers.mjs';

const login = (id, name, extra = {}) => ({ id, type: 1, name, notes: null, folderId: null, login: { username: 'u', uris: [{ uri: 'https://x.test' }] }, attachments: [], ...extra });
const att = (id, fileName) => ({ id, fileName });

test('matchItems pairs unique items, and uses the folder name to tell same-named items apart', () => {
  const oldFolders = [{ id: null, name: 'No Folder' }, { id: 'of1', name: 'One' }, { id: 'of2', name: 'Two' }];
  const newFolders = [{ id: null, name: 'No Folder' }, { id: 'nf1', name: 'One' }, { id: 'nf2', name: 'Two' }];
  const oldItems = [login('o1', 'Same', { folderId: 'of1', attachments: [att('a1', 'a.txt')] }), login('o2', 'Same', { folderId: 'of2', attachments: [att('a2', 'b.txt')] })];
  const newItems = [login('n2', 'Same', { folderId: 'nf2' }), login('n1', 'Same', { folderId: 'nf1' })];
  const { matched, ambiguous, missing } = matchItems({ oldItems, oldFolders, newItems, newFolders });
  assert.deepEqual(matched.map((m) => [m.old.id, m.created.id]), [['o1', 'n1'], ['o2', 'n2']]);
  assert.equal(ambiguous.length + missing.length, 0);
});

test('matchItems never guesses between identical items, and reports vanished ones', () => {
  const folders = [{ id: null, name: 'No Folder' }];
  const twin = (id) => login(id, 'Twin', { attachments: [att(`a-${id}`, 'f.txt')] });
  const { matched, ambiguous, missing } = matchItems({
    oldItems: [twin('o1'), twin('o2'), login('o3', 'Gone', { attachments: [att('a3', 'g.txt')] })],
    oldFolders: folders, newFolders: folders,
    newItems: [login('n1', 'Twin'), login('n2', 'Twin')],
  });
  assert.equal(matched.length, 0);
  assert.deepEqual(ambiguous.map((i) => i.id), ['o1', 'o2']);
  assert.deepEqual(missing.map((i) => i.id), ['o3']);
});

// A backup on disk plus a fake target account that is empty until the import ran.
async function setup({ targetBefore = { items: [], folders: [{ id: null, name: 'No Folder' }] } } = {}) {
  const sb = await makeSandbox();
  const folders = [{ id: null, name: 'No Folder' }, { id: 'of1', name: 'Folder' }];
  const oldItems = [
    login('o1', 'Has file', { folderId: 'of1', attachments: [att('a1', 'one.txt')] }),
    login('o2', 'Other', { attachments: [att('a2', 'two.txt'), att('a3', 'three.txt')] }),
    login('o3', 'No file'),
  ];
  const backup = path.join(sb.dir, 'backup');
  await fs.mkdir(path.join(backup, 'personal'), { recursive: true });
  await fs.writeFile(path.join(backup, 'personal', 'export.json'), JSON.stringify({ folders: [{ id: 'of1', name: 'Folder' }], items: oldItems }));
  await fs.writeFile(path.join(backup, 'personal', 'items.json'), JSON.stringify(oldItems));
  await fs.writeFile(path.join(backup, 'personal', 'folders.json'), JSON.stringify(folders));
  for (const [item, a] of [['Has file', att('a1', 'one.txt')], ['Other', att('a2', 'two.txt')], ['Other', att('a3', 'three.txt')]]) {
    const id = { 'Has file': 'o1', Other: 'o2' }[item];
    const dir = path.join(backup, 'personal', 'attachments', item, id, a.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, a.fileName), `content ${a.id}`);
  }
  const target = path.join(sb.dir, 'target');
  await fs.mkdir(target);
  const after = { items: [login('n1', 'Has file', { folderId: 'nf1' }), login('n2', 'Other'), login('n3', 'No file')], folders: [{ id: null, name: 'No Folder' }, { id: 'nf1', name: 'Folder' }] };
  await fs.writeFile(path.join(target, 'before.json'), JSON.stringify(targetBefore));
  await fs.writeFile(path.join(target, 'after.json'), JSON.stringify(after));
  process.env.FAKE_BW_TARGET_DIR = target;
  const argv = (extra = {}) => ({ credentialsFile: sb.credentialsFile, sourceDir: backup, apply: true, allowNonEmpty: false, ...extra });
  const attachmentCalls = async () => (await sb.bwCalls()).filter((c) => c.args[0] === 'create').map((c) => [c.args[c.args.indexOf('--itemid') + 1], path.basename(c.args[c.args.indexOf('--file') + 1])]);
  return { sb, argv, attachmentCalls };
}

test('dry run (the default) logs in nowhere and changes nothing', async () => {
  const { sb, argv } = await setup();
  await restore(argv({ apply: false }), sb.deps);
  assert.deepEqual(await sb.bwCalls(), []);
  await sb.cleanup();
});

test('apply imports once, then uploads every attachment to the matching new item', async () => {
  const { sb, argv, attachmentCalls } = await setup();
  await restore(argv(), sb.deps);
  const calls = await sb.bwCalls();
  const imports = calls.filter((c) => c.args[0] === 'import');
  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0].args.slice(0, 2), ['import', 'bitwardenjson']);
  assert.deepEqual(await attachmentCalls(), [['n1', 'one.txt'], ['n2', 'two.txt'], ['n2', 'three.txt']]);
  assert.ok(calls.some((c) => c.args[0] === 'logout'));
  assert.doesNotMatch(calls.flatMap((c) => c.args).join(' '), /master-pw|client-secret|SESSIONKEY/);
  await sb.cleanup();
});

test('refuses a target account that is not empty, before importing anything', async () => {
  const { sb, argv } = await setup({ targetBefore: { items: [login('x', 'Existing')], folders: [{ id: null, name: 'No Folder' }] } });
  await assert.rejects(restore(argv(), sb.deps), /not empty/);
  assert.equal((await sb.bwCalls()).some((c) => c.args[0] === 'import'), false);
  await sb.cleanup();
});

test('a failed attachment upload makes the restore fail, but the others are still uploaded', async () => {
  const { sb, argv, attachmentCalls } = await setup();
  process.env.FAKE_BW_FAIL_ATTACH = path.join(sb.dir, 'backup', 'personal', 'attachments', 'Other', 'o2', 'a2', 'two.txt');
  await assert.rejects(restore(argv(), sb.deps), /incompletely.*o2\/a2/s);
  assert.equal((await attachmentCalls()).length, 3); // all three were attempted
  delete process.env.FAKE_BW_FAIL_ATTACH;
  await sb.cleanup();
});

test('needs exactly one source', async () => {
  const { sb, argv } = await setup();
  await assert.rejects(restore(argv({ sourceDir: undefined }), sb.deps), /exactly one of/);
  await assert.rejects(restore(argv({ sourceFile: '/x.7z' }), sb.deps), /exactly one of/);
  await sb.cleanup();
});
