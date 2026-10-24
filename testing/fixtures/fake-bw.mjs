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

if (process.env.FAKE_BW_FAIL === args[0]) fail(`boom, leaked master-pw and SESSIONKEY`);

switch (args[0]) {
  case 'login': break;
  case 'logout': break;
  case 'sync': break;
  case 'unlock': process.env.BW_PASSWORD === 'master-pw' ? out('SESSIONKEY') : fail('Invalid master password.'); break;
  case 'export':
    if (stdin() !== 'master-pw') fail('Invalid master password.');
    fs.writeFileSync(flag('--output'), JSON.stringify({ exported: true, orgId: orgId ?? null }));
    break;
  case 'list':
    if (args[1] === 'items') {
      out(orgId
        ? [{ id: 'oi1', name: 'Org item', attachments: [{ id: 'oa1', fileName: 'a.txt' }, { id: 'oa2', fileName: 'b.txt' }] }]
        : [{ id: 'pi1', name: 'Personal item', attachments: [{ id: 'pa1', fileName: 'p.txt' }] }, { id: 'pi2', name: 'No files' }]);
    }
    if (args[1] === 'folders') out([{ id: 'f1', name: 'Folder' }]);
    if (args[1] === 'organizations') out([{ id: 'org-1', name: 'My Org' }]);
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
