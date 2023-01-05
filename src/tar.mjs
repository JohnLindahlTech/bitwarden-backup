import { execa } from 'execa';
import { ENCRYPT_FILE_EXTENSION } from './constants.mjs';
import logger from './log.mjs';


export async function tar(target, source){
  
  const cmdArgs = ['-czvf', target, '-C', source, '.'];
  const execaOpts = {};
  try {
    const { stdout } = await execa('tar', cmdArgs, execaOpts);
    logger.debug(stdout);
  } catch(err){
    throw err;
  }
}

export async function untar(source, target){
  const cmdArgs = ['-xzvf', source, '-C', target];
  const execaOpts = {};
  try {
    const { stdout } = await execa('tar', cmdArgs, execaOpts);
    logger.debug(stdout);
  } catch(err){
    throw err;
  }
}

export async function encrypt(target, argv){
  const cmdArgs = ['a', '-t7z','-m0=lzma2', '-mx=9', '-mfb=64', '-md=32m', '-ms=on', '-mhe=on', `-p${argv.passphrase}`,`${target}${ENCRYPT_FILE_EXTENSION}`, target];
  const execaOpts = {};
  try {
    const { stdout } = await execa('7z', cmdArgs, execaOpts);
    logger.debug(stdout);
  } catch(err){
    throw err;
  }
}

export async function decrypt(argv){
  const cmdArgs = ['x', '-y',`-p${argv.passphrase}`, argv.sourceFile, `-o${argv.unpackDir}`];
  const execaOpts = {};
  try {
    const { stdout } = await execa('7z', cmdArgs, execaOpts);
    logger.debug(stdout);
  } catch(err){
    throw err;
  }
}