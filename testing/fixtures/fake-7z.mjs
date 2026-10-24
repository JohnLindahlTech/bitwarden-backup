#!/usr/bin/env node
// Fake `7z`: "encrypts" by copying, but insists on the passphrase arriving on stdin.
import fs from 'node:fs';

const args = process.argv.slice(2);
const expected = process.env.FAKE_7Z_PASSPHRASE;
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_7Z_LOG, JSON.stringify(args) + '\n');

if (args.some((a) => a.includes(expected))) { console.error('passphrase leaked into argv'); process.exit(3); }
if (args[0] === 'a') {
  if (stdin !== `${expected}\n${expected}\n`) process.exit(2);
  fs.copyFileSync(args.at(-1), args.at(-2));
} else if (args[0] === 'x') {
  if (args.some((a) => a.startsWith('-p'))) { console.error('real 7z ignores stdin when -p is given on extract'); process.exit(3); }
  if (stdin !== `${expected}\n`) { console.error('Wrong password'); process.exit(2); }
  process.stdout.write(fs.readFileSync(args.at(-1)));
}
