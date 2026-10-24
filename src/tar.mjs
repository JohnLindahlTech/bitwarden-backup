import { execa } from 'execa';
import { ENCRYPT_FILE_EXTENSION } from './constants.mjs';

// The passphrase goes to 7z over stdin, so it never shows up in `ps`. When creating, `-p` without a
// value makes 7z prompt twice. When extracting, 7z prompts by itself, and a bare `-p` would NOT read stdin.

export async function tar(target, source, { tarBin = 'tar' } = {}) {
  await execa(tarBin, ['-czf', target, '-C', source, '.']);
}

export async function encrypt(archive, passphrase, { sevenZipBin = '7z' } = {}) {
  const target = `${archive}${ENCRYPT_FILE_EXTENSION}`;
  const args = ['a', '-t7z', '-m0=lzma2', '-mx=9', '-mfb=64', '-md=32m', '-ms=on', '-mhe=on', '-p', target, archive];
  await execa(sevenZipBin, args, { input: `${passphrase}\n${passphrase}\n` });
  return target;
}

// Streams 7z -> tar, so no intermediate .tar.gz is written to disk.
export async function decryptAndUntar({ sourceFile, passphrase, targetDir }, { sevenZipBin = '7z', tarBin = 'tar' } = {}) {
  const decrypt = execa(sevenZipBin, ['x', '-so', sourceFile], { input: `${passphrase}\n` });
  await decrypt.pipe(execa(tarBin, ['-xzf', '-', '-C', targetDir]));
}
