'use strict';

const assert = require('node:assert/strict');
const { decide } = require('../src/work-file-uploader');

for (const filename of [
  'generador_pedidos.zip',
  'Nenova.html',
  'nenova_app.zip',
  'Import_Team_Checklist_Diario_2.html',
  'GENERADOR_PEDIDOS.ZIP',
  'NENOVA.HTML',
  'NENOVA_APP.ZIP',
  'IMPORT_TEAM_CHECKLIST_DIARIO_2.HTML',
]) {
  assert.equal(decide({ filename }), 'ok', filename);
}

assert.equal(decide({ filename: 'Nenova 개인.html' }), 'personal');
assert.equal(decide({ filename: '개인.HTM' }), 'personal');
assert.equal(decide({ filename: 'daily.html' }), 'no-signal');
assert.equal(decide({ filename: 'daily.HTM' }), 'no-signal');
assert.equal(decide({ filename: 'abcdef.html' }), 'junk');
assert.equal(decide({ filename: '~$Nenova.html' }), 'temp');
assert.equal(decide({ filename: '가족.zip' }), 'personal');
assert.equal(decide({ filename: 'tool.exe' }), 'ext');
assert.equal(decide({ filename: 'tool.js' }), 'ext');
assert.equal(decide({ filename: 'daily.zip' }), 'no-signal');
assert.equal(decide({ filename: 'backup.exe.zip' }), 'no-signal');
assert.equal(decide({ filename: 'order.zip' }), 'ok');
assert.equal(decide({ filename: 'order.html' }), 'ok');
assert.equal(decide({ filename: '입고.HTM' }), 'ok');
assert.equal(decide({ filename: 'order.zip.exe' }), 'ext');
assert.equal(decide({ filename: '38-2.xlsx' }), 'ok');

console.log('work-file-uploader checks passed');
