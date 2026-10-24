#!/usr/bin/env node
// Compares an UNPACKED backup (a directory containing personal/ and org/) of the seeded test account with
// tmp/test-vw-a.seed.json: item counts, organization folders by id, and the sha256 of every attachment.
// Usage: node scripts/verify-against-seed.mjs <unpacked backup dir> [--personal-only]
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const personalOnly = process.argv.includes('--personal-only');
const dir = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!dir) { console.error('usage: verify-against-seed.mjs <unpacked backup dir>'); process.exit(2); }
const manifest = JSON.parse(await fs.readFile(new URL('../tmp/test-vw-a.seed.json', import.meta.url), 'utf8'));
const read = async (...p) => JSON.parse(await fs.readFile(path.join(dir, ...p), 'utf8'));

async function files(d) {
  const out = [];
  for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(d, e.name);
    e.isDirectory() ? out.push(...await files(p)) : out.push(p);
  }
  return out;
}
const hashes = async (d) => (await Promise.all((await files(d)).map(async (f) => createHash('sha256').update(await fs.readFile(f)).digest('hex')))).sort();
const expectedHashes = (items) => items.flatMap((i) => i.attachments.map((a) => a.sha256)).sort();

let failed = 0;
const check = (ok, label, detail = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`); if (!ok) failed++; };
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// personal
const pItems = await read('personal', 'items.json');
const pExport = await read('personal', 'export.json');
check(pItems.length === manifest.personal.items.length, 'personal items.json count', `${pItems.length} vs seeded ${manifest.personal.items.length}`);
check((pExport.items ?? []).length === manifest.personal.items.length, 'personal export.json count', `${(pExport.items ?? []).length}`);
check(pItems.every((i) => !i.organizationId), 'personal items contain no organization items');
check(sameList(await hashes(path.join(dir, 'personal', 'attachments')), expectedHashes(manifest.personal.items)), 'personal attachments: identical contents (sha256)', `${expectedHashes(manifest.personal.items).length} files`);
check((await read('personal', 'folders.json')).some((f) => f.name === 'Playground folder'), 'personal folder present');

// organizations
if (personalOnly) { console.log(failed ? `\n${failed} check(s) FAILED` : '\nall personal checks passed'); process.exit(failed ? 1 : 0); }
const orgDirs = {};
for (const name of await fs.readdir(path.join(dir, 'org')).catch(() => [])) {
  for (const id of await fs.readdir(path.join(dir, 'org', name)).catch(() => [])) orgDirs[id] = path.join(dir, 'org', name, id);
}
check(manifest.orgs.every((o) => orgDirs[o.id]), 'every organization has its own org/<name>/<id>/ folder', `${Object.keys(orgDirs).length} found, ${manifest.orgs.length} seeded`);
for (const org of manifest.orgs) {
  const d = orgDirs[org.id];
  if (!d) continue;
  const items = await read(path.relative(dir, d), 'items.json');
  check(items.length === org.items.length, `org ${org.id.slice(0, 8)} items.json count`, `${items.length} vs seeded ${org.items.length}`);
  check(sameList(await hashes(path.join(d, 'attachments')), expectedHashes(org.items)), `org ${org.id.slice(0, 8)} attachments: identical contents (sha256)`, `${expectedHashes(org.items).length} files`);
  check((await read(path.relative(dir, d), 'collections.json')).length === org.collections.length, `org ${org.id.slice(0, 8)} collections`, `${org.collections.length}`);
}
const skipped = await read('org', 'skipped.json').catch(() => null);
check(Array.isArray(skipped) && skipped.length === 0, 'no organization was skipped');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
