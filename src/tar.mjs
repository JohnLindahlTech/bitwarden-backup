import { execa } from 'execa';
import logger from './log.mjs'
// Maybe just execa: "zip --encrypt 2022-12-02_backup.zip -r folder_to_backup" ?
// https://askubuntu.com/a/1125254
// sudo apt-get install p7zip-full  # install 7zip
// 7za a -tzip -p -mem=AES256 foo_file.zip foo_folder  # encrypt folder


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

export async function encrypt(target, argv){
  const cmdArgs = ['-e', '-E','BWBU_P_PHRASE', target];
  const execaOpts = {
    env: {
      BWBU_P_PHRASE: argv.passphrase
    }
  };
  try {
    const { stdout } = await execa('ccrypt', cmdArgs, execaOpts);
    logger.debug(stdout);
  } catch(err){
    throw err;
  }
}