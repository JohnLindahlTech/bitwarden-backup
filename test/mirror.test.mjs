import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKER, fingerprint, planSync, readMarkers, targetPayload, withAttachmentMarker } from '../src/mirror.mjs';

const NO_FOLDER = { id: null, name: 'No Folder' };
const src = (id, name, extra = {}) => ({ id, type: 1, name, notes: null, favorite: false, folderId: null, fields: [], login: { username: 'u', password: 'p', uris: [{ uri: 'https://x.test', match: null }] }, attachments: [], ...extra });
// what the target holds after a mirror run: the payload we would have written, with an id of its own
const mirrored = (item, id, { fp, attachments = [], folderName = null, extra = {} } = {}) => ({
  ...targetPayload(item, { folderId: null, fp: fp ?? fingerprint(item, folderName), attachments }), id, attachments: [], ...extra,
});
const plan = (over) => planSync({ sourceFolders: [NO_FOLDER], targetItems: [], ...over });

test('a fingerprint ignores ids, dates, markers and attachments but notices real changes', () => {
  const a = src('s1', 'Login');
  assert.equal(fingerprint(a), fingerprint({ ...a, id: 'other', revisionDate: 'x', attachments: [{ id: 'a' }], fields: [{ name: `${MARKER.src}`, value: 'v', type: 0 }] }));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, name: 'Renamed' }));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, login: { ...a.login, password: 'changed' } }));
  assert.notEqual(fingerprint(a, 'Folder A'), fingerprint(a, 'Folder B'));
});

test('an empty target gets everything created', () => {
  const p = plan({ sourceItems: [src('s1', 'A'), src('s2', 'B')] });
  assert.deepEqual(p.create.map((e) => e.item.id), ['s1', 's2']);
  assert.equal(p.update.length + p.trash.length + p.unchanged.length, 0);
});

test('a second run against its own result is a no-op (idempotent)', () => {
  const items = [src('s1', 'A'), src('s2', 'B', { attachments: [{ id: 'att1' }] })];
  const target = [mirrored(items[0], 't1'), mirrored(items[1], 't2', { attachments: [{ i: 'att1', t: 'tatt1' }] })];
  const p = plan({ sourceItems: items, targetItems: target });
  assert.deepEqual(p.unchanged.map((e) => e.item.id), ['s1', 's2']);
  assert.equal(p.create.length + p.update.length + p.trash.length, 0);
});

test('changed source content updates the matching target item, nothing else', () => {
  const old = src('s1', 'A');
  const p = plan({ sourceItems: [{ ...old, name: 'A renamed' }, src('s2', 'B')], targetItems: [mirrored(old, 't1'), mirrored(src('s2', 'B'), 't2')] });
  assert.deepEqual(p.update.map((e) => [e.item.id, e.target.id]), [['s1', 't1']]);
  assert.deepEqual(p.unchanged.map((e) => e.item.id), ['s2']);
});

test('items that left the source are trashed, unmarked target items are never touched', () => {
  const p = plan({ sourceItems: [src('s1', 'A')], targetItems: [mirrored(src('s1', 'A'), 't1'), mirrored(src('gone', 'Gone'), 't9'), { id: 'mine', name: 'Not ours', fields: [] }] });
  assert.deepEqual(p.trash.map((t) => t.id), ['t9']);
  assert.equal(p.unmanaged, 1);
});

test('an item that comes back from the source trash is restored, not duplicated', () => {
  const item = src('s1', 'A');
  const p = plan({ sourceItems: [item], targetItems: [], targetTrashed: [mirrored(item, 't1')] });
  assert.deepEqual(p.restoreFromTrash.map((e) => e.target.id), ['t1']);
  assert.equal(p.create.length, 0);
});

test('attachments are diffed by source attachment id', () => {
  const item = src('s1', 'A', { attachments: [{ id: 'keep' }, { id: 'new' }] });
  const target = mirrored(src('s1', 'A'), 't1', { fp: fingerprint(item), attachments: [{ i: 'keep', t: 'tk' }, { i: 'removed', t: 'tr' }] });
  const [entry] = plan({ sourceItems: [item], targetItems: [target] }).update;
  assert.deepEqual(entry.upload.map((a) => a.id), ['new']);
  assert.deepEqual(entry.remove, [{ i: 'removed', t: 'tr' }]);
  assert.equal(entry.contentUnchanged, true);
});

test('duplicate mirrors of one source item are reported, only the first is used', () => {
  const item = src('s1', 'A');
  const p = plan({ sourceItems: [item], targetItems: [mirrored(item, 't1'), mirrored(item, 't2')] });
  assert.deepEqual(p.duplicates, [{ source: 's1', targets: ['t1', 't2'] }]);
  assert.equal(p.unchanged.length, 1);
});

test('force rewrites unchanged items', () => {
  const item = src('s1', 'A');
  assert.equal(plan({ sourceItems: [item], targetItems: [mirrored(item, 't1')], force: true }).update.length, 1);
});

test('markers survive a round trip, and a damaged attachment marker is harmless', () => {
  const item = src('s1', 'A');
  const t = mirrored(item, 't1', { attachments: [{ i: 'a', t: 'b' }] });
  assert.deepEqual(readMarkers(t), { src: 's1', fp: fingerprint(item), attachments: [{ i: 'a', t: 'b' }] });
  const broken = { fields: [{ name: MARKER.src, value: 's1' }, { name: MARKER.att, value: '{not json' }] };
  assert.deepEqual(readMarkers(broken).attachments, []);
  assert.deepEqual(readMarkers(withAttachmentMarker(t, [{ i: 'x', t: 'y' }])).attachments, [{ i: 'x', t: 'y' }]);
  assert.equal('attachments' in withAttachmentMarker(t, []), false);
});

test('the payload never carries ids, dates or passkeys, and keeps the user fields', () => {
  const item = src('s1', 'A', { revisionDate: 'r', creationDate: 'c', collectionIds: ['x'], fields: [{ name: 'mine', value: 'v', type: 1 }], login: { username: 'u', fido2Credentials: [{ credentialId: 'k' }], passwordRevisionDate: 'd' } });
  const payload = targetPayload(item, { folderId: 'f1', fp: 'abc' });
  assert.equal(payload.id, undefined);
  assert.equal(payload.revisionDate, undefined);
  assert.equal(payload.login.fido2Credentials, undefined);
  assert.equal(payload.folderId, 'f1');
  assert.deepEqual(payload.fields.map((f) => f.name), ['mine', MARKER.src, MARKER.fp]);
});
