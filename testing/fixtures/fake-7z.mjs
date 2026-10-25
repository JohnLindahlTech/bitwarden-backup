#!/usr/bin/env node
// Fake `7z`: "encrypts" by tarring, but insists on the real 7z calling conventions:
// the passphrase arrives on stdin (never argv), `a` runs in the source dir with `.`,
// and `x` must NOT get -p (the real 7z then ignores stdin and fails).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const expected = process.env.FAKE_7Z_PASSPHRASE;
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_7Z_LOG, JSON.stringify(args) + '\n');

if (args.some((a) => a.includes(expected))) { console.error('passphrase leaked into argv'); process.exit(3); }
if (args[0] === 'a') {
  if (stdin !== `${expected}\n${expected}\n`) process.exit(2);
  if (args.at(-1) !== '.') { console.error('expected to archive "." from the source cwd'); process.exit(3); }
  execFileSync('tar', ['-czf', args.at(-2), '-C', '.', '.']);
} else if (args[0] === 'x') {
  if (args.some((a) => a.startsWith('-p'))) { console.error('real 7z ignores stdin when -p is given on extract'); process.exit(3); }
  if (stdin !== `${expected}\n`) { console.error('Wrong password'); process.exit(2); }
  const out = args.find((a) => a.startsWith('-o')).slice(2);
  fs.mkdirSync(out, { recursive: true });
  execFileSync('tar', ['-xzf', args.at(-1), '-C', out]);
}
