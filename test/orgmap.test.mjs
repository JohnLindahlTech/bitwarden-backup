import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportBlocker, resolveOrgMapping } from '../src/orgmap.mjs';

const src = (id, name, ...items) => ({ id, name, itemIds: new Set(items) });
const tgt = (id, name, extra = {}) => ({ id, name, type: 0, status: 2, enabled: true, ...extra });
const ids = (r) => Object.fromEntries([...r.mapping].map(([s, t]) => [s, t.id]));

test('a unique name match is mapped', () => {
  const r = resolveOrgMapping({ sourceOrgs: [src('s1', 'Family')], targetOrgs: [tgt('t1', 'Family'), tgt('t2', 'Work')] });
  assert.deepEqual(ids(r), { s1: 't1' });
  assert.equal(r.unmapped.length, 0);
});

test('same-named organizations are never guessed, on either side', () => {
  const r = resolveOrgMapping({ sourceOrgs: [src('s1', 'Org'), src('s2', 'Org')], targetOrgs: [tgt('t1', 'Org'), tgt('t2', 'Org')] });
  assert.equal(r.mapping.size, 0);
  assert.deepEqual(r.unmapped.map((u) => u.org.id), ['s1', 's2']);
  assert.match(r.unmapped[0].reason, /choose with --org/);
});

test('markers from an earlier run decide, even between same-named organizations', () => {
  const r = resolveOrgMapping({
    sourceOrgs: [src('s1', 'Org', 'i1'), src('s2', 'Org', 'i2')], targetOrgs: [tgt('t1', 'Org'), tgt('t2', 'Org')],
    markedSources: new Map([['t1', new Set(['i2'])], ['t2', new Set(['i1'])]]),
  });
  assert.deepEqual(ids(r), { s1: 't2', s2: 't1' });
});

test('--org wins over everything, and must point at an organization we can write to', () => {
  const targetOrgs = [tgt('t1', 'Org'), tgt('t2', 'Org'), tgt('member', 'Other', { type: 2, permissions: { accessImportExport: false } })];
  assert.deepEqual(ids(resolveOrgMapping({ sourceOrgs: [src('s1', 'Org')], targetOrgs, explicit: { s1: 't2' } })), { s1: 't2' });
  const bad = resolveOrgMapping({ sourceOrgs: [src('s1', 'Org')], targetOrgs, explicit: { s1: 'member' } });
  assert.equal(bad.mapping.size, 0);
  assert.match(bad.unmapped[0].reason, /not an organization you can write to/);
});

test('one target organization is never used for two backed-up ones', () => {
  const r = resolveOrgMapping({ sourceOrgs: [src('s1', 'A'), src('s2', 'B')], targetOrgs: [tgt('t1', 'A')], explicit: { s2: 't1' } });
  assert.deepEqual(ids(r), { s2: 't1' });
  assert.equal(r.unmapped.length, 1); // s1 matched by name, but t1 is taken
  assert.match(r.unmapped[0].reason, /already used for another/);
});

test('a missing target organization is reported with what to do', () => {
  const r = resolveOrgMapping({ sourceOrgs: [src('s1', 'Gone')], targetOrgs: [tgt('t1', 'Other')] });
  assert.match(r.unmapped[0].reason, /create it first/);
});

test('organizations we cannot export from are not candidates', () => {
  assert.match(exportBlocker(tgt('t', 'x', { enabled: false })), /disabled/);
  assert.match(exportBlocker(tgt('t', 'x', { status: 0 })), /not confirmed/);
  assert.match(exportBlocker(tgt('t', 'x', { type: 2 })), /not an owner\/admin/);
  assert.equal(exportBlocker(tgt('t', 'x')), undefined);
  assert.equal(resolveOrgMapping({ sourceOrgs: [src('s1', 'x')], targetOrgs: [tgt('t', 'x', { type: 2 })] }).mapping.size, 0);
});
