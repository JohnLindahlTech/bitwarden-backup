#!/usr/bin/env node
// Fake `bw` for tests. Logs every call to $FAKE_BW_LOG and fails when asked to.
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const orgId = args.includes('--organizationid') ? flag('--organizationid') : undefined;
const stdin = () => fs.readFileSync(0, 'utf8');

fs.appendFileSync(process.env.FAKE_BW_LOG, JSON.stringify({ args, session: process.env.BW_SESSION, clientId: process.env.BW_CLIENTID }) + '\n');

const fail = (msg, code = 1) => { process.stderr.write(`${msg}\n`); process.exit(code); };
const out = (data) => process.stdout.write(typeof data === 'string' ? data : JSON.stringify(data));

// --- stateful fake target account (restore/mirror tests): FAKE_BW_STATE is a JSON file {items, folders, seq} ---
function target() {
  const file = process.env.FAKE_BW_STATE;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const save = () => fs.writeFileSync(file, JSON.stringify(state));
  const next = (prefix) => `${prefix}${++state.seq}`;
  const body = () => JSON.parse(Buffer.from(stdin(), 'base64').toString());
  const find = (id) => state.items.find((i) => i.id === id);
  const [cmd, kind] = args;
  // like the real bw: without an org id the list contains the organization items too
  if (cmd === 'list' && kind === 'items') { out(state.items.filter((i) => Boolean(i.deletedDate) === args.includes('--trash') && (!orgId || i.organizationId === orgId))); return true; }
  if (cmd === 'list' && kind === 'organizations' && state.orgs) { out(state.orgs); return true; }
  if (cmd === 'list' && kind === 'org-collections' && state.collections) { out(state.collections.filter((c) => c.organizationId === orgId)); return true; }
  if (cmd === 'create' && kind === 'org-collection') { const c = { id: next('tc'), ...body() }; (state.collections ??= []).push(c); save(); out(c); return true; }
  if (cmd === 'edit' && kind === 'item-collections') { const item = find(args[2]); item.collectionIds = body(); save(); out('Edited item collections.'); return true; }
  if (cmd === 'list' && kind === 'folders') { out([{ id: null, name: 'No Folder' }, ...state.folders]); return true; }
  if (cmd === 'create' && kind === 'folder') { const f = { id: next('tf'), name: body().name }; state.folders.push(f); save(); out(f); return true; }
  if (cmd === 'create' && kind === 'item') { const item = { ...body(), id: next('t'), attachments: [], deletedDate: null }; state.items.push(item); save(); out(item); return true; }
  // like the real bw, `edit item` leaves collections alone (see edit item-collections)
  if (cmd === 'edit' && kind === 'item') { const old = find(args[2]); Object.assign(old, body(), { id: old.id, attachments: old.attachments, deletedDate: old.deletedDate, collectionIds: old.collectionIds }); save(); out(old); return true; }
  if (cmd === 'get' && kind === 'item') { out(find(args[2])); return true; }
  if (cmd === 'delete' && kind === 'item') { find(args[2]).deletedDate = 'now'; save(); return true; }
  if (cmd === 'restore' && kind === 'item') { const item = find(args[2]); item.deletedDate = null; save(); out('Item restored.'); return true; }
  if (cmd === 'create' && kind === 'attachment') {
    const path = flag('--file');
    if (process.env.FAKE_BW_FAIL_ATTACH && path.includes(process.env.FAKE_BW_FAIL_ATTACH)) fail('upload failed');
    const item = find(flag('--itemid'));
    item.attachments.push({ id: next('ta'), fileName: path.split('/').at(-1), size: fs.statSync(path).size });
    save(); out(item); return true;
  }
  if (cmd === 'delete' && kind === 'attachment') { const item = find(flag('--itemid')); item.attachments = item.attachments.filter((a) => a.id !== args[2]); save(); return true; }
  if (cmd === 'import') {
    const data = JSON.parse(fs.readFileSync(args[2], 'utf8'));
    const ids = new Map();
    for (const f of data.folders ?? []) { const created = { id: next('tf'), name: f.name }; state.folders.push(created); ids.set(f.id, created.id); }
    for (const i of data.items) state.items.push({ ...i, id: next('t'), folderId: ids.get(i.folderId) ?? null, attachments: [], deletedDate: null });
    state.imports = (state.imports ?? 0) + 1;
    save(); return true;
  }
  return false;
}
if (process.env.FAKE_BW_STATE && !['login', 'logout', 'sync', 'unlock', 'config'].includes(args[0]) && target()) process.exit(0);

if (process.env.FAKE_BW_FAIL === args[0]) fail(`boom, leaked master-pw and SESSIONKEY, FetchError: request to https://x.test/attachments/1/2?token=SECRETTOKEN failed`);

switch (args[0]) {
  case 'config': break;
  case 'login': break;
  case 'logout': break;
  case 'sync': break;
  case 'unlock': process.env.BW_PASSWORD === 'master-pw' ? out('SESSIONKEY') : fail('Invalid master password.'); break;
  case 'export':
    if (stdin() !== 'master-pw') fail('Invalid master password.');
    fs.writeFileSync(flag('--output'), JSON.stringify({ exported: true, orgId: orgId ?? null }));
    break;
  case 'import': {
    // restore tests: importing flips the fake target account from before.json to after.json
    if (!process.env.FAKE_BW_TARGET_DIR) fail('no target configured', 2);
    fs.writeFileSync(`${process.env.FAKE_BW_TARGET_DIR}/imported`, '1');
    break;
  }
  case 'create':
    if (args[1] === 'attachment' && process.env.FAKE_BW_FAIL_ATTACH && args.includes(process.env.FAKE_BW_FAIL_ATTACH)) fail('upload failed');
    break;
  case 'list':
    if (process.env.FAKE_BW_TARGET_DIR && !orgId && (args[1] === 'items' || args[1] === 'folders')) {
      const dir = process.env.FAKE_BW_TARGET_DIR;
      const state = JSON.parse(fs.readFileSync(`${dir}/${fs.existsSync(`${dir}/imported`) ? 'after' : 'before'}.json`, 'utf8'));
      out(args[1] === 'items' ? state.items : state.folders);
      break;
    }
    if (args[1] === 'items') {
      out(orgId
        ? [{ id: 'oi1', name: 'Org item', attachments: [{ id: 'oa1', fileName: 'a.txt' }, { id: 'oa2', fileName: 'b.txt' }] }]
        : [{ id: 'xi1', name: 'Org item seen via personal list', organizationId: 'org-1', attachments: [{ id: 'xa1', fileName: 'x.txt' }] },
           { id: 'pi1', name: 'Personal item', attachments: [{ id: 'pa1', fileName: 'p.txt' }] }, { id: 'pi2', name: 'No files' }]);
    }
    if (args[1] === 'folders') out([{ id: 'f1', name: 'Folder' }]);
    if (args[1] === 'organizations') {
      out([
        { id: 'org-1', name: 'My Org', type: 0, status: 2, enabled: true, permissions: { accessImportExport: true } },
        ...(process.env.FAKE_BW_EXTRA_ORGS ? [
          { id: 'org-2', name: 'Member Org', type: 2, status: 2, enabled: true, permissions: { accessImportExport: false } },
          { id: 'org-3', name: 'Invited Org', type: 2, status: 0, enabled: true },
          { id: 'org-4', name: 'Disabled Org', type: 0, status: 2, enabled: false },
        ] : []),
      ]);
    }
    if (args[1] === 'org-collections') out([{ id: 'c1', name: 'Collection' }]);
    break;
  case 'get': {
    const fileId = args[2];
    if (fileId === process.env.FAKE_BW_FAIL_FILE) fail('attachment download failed');
    fs.mkdirSync(flag('--output'), { recursive: true });
    fs.writeFileSync(`${flag('--output')}file.txt`, `content of ${fileId}`);
    break;
  }
  default: fail(`unexpected command ${args.join(' ')}`, 2);
}
