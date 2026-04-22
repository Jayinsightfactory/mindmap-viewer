// Isolated uiohook crash reproduction test
// Run: node setup/uiohook-isolated-test.js
// Stays alive 60 seconds. If crash: exit code != 0 + stderr.

process.on('uncaughtException', (e) => {
  console.error('[UNCAUGHT]', e.message, e.stack);
  process.exit(10);
});

process.on('unhandledRejection', (e) => {
  console.error('[UNHANDLED REJECTION]', e);
});

const fs = require('fs');
const path = require('path');
const LOG = path.join(require('os').homedir(), '.orbit', 'uiohook-test.log');

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  console.log(msg);
  try { fs.appendFileSync(LOG, line); } catch {}
}

log(`[START] Node ${process.version} ${process.platform}-${process.arch}`);
log(`[START] PID ${process.pid}`);

let uiohook;
try {
  const lib = require('uiohook-napi');
  uiohook = lib.uIOhook;
  log(`[LOAD] uiohook-napi loaded. Keys: ${Object.keys(lib).join(',')}`);
} catch (e) {
  log(`[LOAD ERROR] ${e.message}`);
  process.exit(11);
}

let keyCount = 0;
let mouseCount = 0;
const startTs = Date.now();

try {
  uiohook.on('keydown', (e) => {
    keyCount++;
    if (keyCount <= 3) log(`[KEY] keydown keycode=${e.keycode} (count=${keyCount})`);
  });
  uiohook.on('mousedown', (e) => {
    mouseCount++;
    if (mouseCount <= 3) log(`[MOUSE] mousedown btn=${e.button} (count=${mouseCount})`);
  });
  log(`[EVT] handlers attached`);
} catch (e) {
  log(`[HANDLER ERROR] ${e.message}`);
  process.exit(12);
}

try {
  log(`[START] calling uiohook.start()...`);
  uiohook.start();
  log(`[START] uiohook.start() returned — hook active`);
} catch (e) {
  log(`[START ERROR] ${e.message} ${e.stack}`);
  process.exit(13);
}

// Heartbeat every 5s
const hb = setInterval(() => {
  const elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
  log(`[ALIVE t=${elapsed}s] keys=${keyCount} mouse=${mouseCount}`);
}, 5000);

// Graceful stop after 60s
setTimeout(() => {
  log(`[STOP] 60s elapsed — stopping uiohook`);
  clearInterval(hb);
  try { uiohook.stop(); log('[STOP] uiohook.stop() OK'); } catch (e) { log(`[STOP ERROR] ${e.message}`); }
  log(`[END] keys=${keyCount} mouse=${mouseCount} — clean exit`);
  process.exit(0);
}, 60000);
