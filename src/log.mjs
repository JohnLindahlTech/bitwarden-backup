const DEBUG='DEBUG';
const INFO='INFO';
const WARN='WARN';
const ERROR='ERROR';

const order = [ERROR, WARN, INFO, DEBUG];

function pDate(){
  return `[${new Date().toISOString()}]`;
}

export function logLevel(comparedLevel){
  const activeLogLevel = (process.env.LOG_LEVEL ?? INFO).toUpperCase();

  return order.indexOf(activeLogLevel) >= order.indexOf(comparedLevel.toUpperCase());
}

export function debug(...args){
  if(logLevel(DEBUG)){
    console.debug(pDate(), `[${DEBUG}]`, ...args);
  }
}

export function info(...args){
  if(logLevel(INFO)){
    console.info(pDate(), ` [${INFO}]`, ...args);
  }
}

export function warn(...args){
  if(logLevel(WARN)){
    console.warn(pDate(), ` [${WARN}]`, ...args);
  }
}

export function error(...args){
  if(logLevel(ERROR)){
    console.error(pDate(), `[${ERROR}]`, ...args)
  }
}

export default {
  debug,
  info,
  warn,
  error,
  log: info,
  logLevel
}