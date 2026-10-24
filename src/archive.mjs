import { execa } from 'execa';

// One encrypted .7z holds everything (AES-256, file names hidden by -mhe=on).
// The passphrase goes to 7z over stdin so it never shows up in `ps`:
// - creating: a bare `-p` makes 7z prompt twice
// - extracting: 7z prompts by itself, a bare `-p` would NOT read stdin there

export async function createArchive({ source, target, passphrase }, { sevenZipBin = '7z' } = {}) {
  const args = ['a', '-t7z', '-m0=lzma2', '-mx=9', '-mfb=64', '-md=32m', '-ms=on', '-mhe=on', '-p', target, '.'];
  await execa(sevenZipBin, args, { cwd: source, input: `${passphrase}\n${passphrase}\n` });
}

export async function extractArchive({ sourceFile, targetDir, passphrase }, { sevenZipBin = '7z' } = {}) {
  await execa(sevenZipBin, ['x', `-o${targetDir}`, sourceFile], { input: `${passphrase}\n` });
}
