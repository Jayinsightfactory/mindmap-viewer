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

// ── 2026-11-09 누락 규칙 보강 ───────────────────────────────────────────
// (a) 확장자 추가: xlsb·hwpx 는 watcher 가 감시하는데 uploader 가 버리던 불일치 해소. txt 는 업무 신호 있을 때만.
assert.equal(decide({ filename: '38-2 발주.xlsb' }), 'ok');
assert.equal(decide({ filename: '견적서.hwpx' }), 'ok');
assert.equal(decide({ filename: 'order.txt' }), 'ok');       // txt + 업무 신호
assert.equal(decide({ filename: 'daily.txt' }), 'no-signal'); // txt + 신호 없음 → 버림
assert.equal(decide({ filename: 'note.txt' }), 'personal');   // 개인 txt 보호 유지
assert.equal(decide({ filename: 'tool.exe' }), 'ext');        // 비업무 확장자 여전히 차단

// (b) 차수 표기 확장: 38주차 / 38W / 제38차 / 2026-38-2
assert.equal(decide({ filename: '38주차.xlsx' }), 'ok');
assert.equal(decide({ filename: '38W.xlsx' }), 'ok');
assert.equal(decide({ filename: '제38차.pdf' }), 'ok');
assert.equal(decide({ filename: '2026-38-2.xlsx' }), 'ok');

// (b) 업무 단어 영문/스페인어 확장 (가브리엘 등 스페인어 거래처 파일명)
assert.equal(decide({ filename: 'factura-123.pdf' }), 'ok');
assert.equal(decide({ filename: 'cotización.xlsx' }), 'ok');
assert.equal(decide({ filename: 'remesa.pdf' }), 'ok');
assert.equal(decide({ filename: 'packing list.xlsx' }), 'ok');
assert.equal(decide({ filename: '중HUB.pdf' }), 'ok'); // 실제 누락 파일(40-2 중HUB.pdf) 유형

// (b) 폴더 경로 업무 신호: 파일명엔 신호 없지만 상위 폴더에 있으면 인정
assert.equal(decide({ filename: 'sheet1.xlsx', fullPath: 'C:\\Users\\u\\Documents\\45차 발주\\sheet1.xlsx' }), 'ok');
assert.equal(decide({ filename: 'sheet1.xlsx', fullPath: 'C:\\Users\\u\\Documents\\기타\\sheet1.xlsx' }), 'no-signal');
// 개인 폴더 오탐 방지: 폴더에 개인 신호가 있으면 폴더 신호를 쓰지 않는다
assert.equal(decide({ filename: 'sheet1.xlsx', fullPath: 'C:\\Users\\u\\Documents\\급여 발주\\sheet1.xlsx' }), 'no-signal');

// 개인 파일 규칙은 완화하지 않았다(회귀 확인)
assert.equal(decide({ filename: '여권사본.pdf' }), 'personal');
assert.equal(decide({ filename: '계약서.docx' }), 'personal');
assert.equal(decide({ filename: '급여명세.xlsx' }), 'personal');

// (버그수정) 소문자 단어 업무 파일이 junk 로 버려지던 문제 — 이제 업무 신호가 junk 보다 우선
assert.equal(decide({ filename: 'invoice.pdf' }), 'ok');
assert.equal(decide({ filename: 'pedido.xlsx' }), 'ok');
assert.equal(decide({ filename: 'factura.pdf' }), 'ok');
assert.equal(decide({ filename: 'remesa.pdf' }), 'ok');
assert.equal(decide({ filename: 'abcdef.html' }), 'junk'); // 신호 없는 소문자 6자 → 여전히 junk

// 사유별 표본/카운터가 getStats 로 노출되는지(개인은 파일명 미노출)
const { onFileChange, getStats } = require('../src/work-file-uploader');
onFileChange({ eventType: 'change', filename: 'tool.exe', fullPath: 'C:\\x\\tool.exe' });        // ext
onFileChange({ eventType: 'change', filename: '여권.pdf', fullPath: 'C:\\x\\여권.pdf' });          // personal
onFileChange({ eventType: 'change', filename: 'daily.xlsx', fullPath: 'C:\\x\\daily.xlsx' });     // no-signal
const s = getStats();
assert.ok(s.skippedExt >= 1 && s.skippedPersonal >= 1 && s.skippedNoSignal >= 1, 'counters increment');
assert.ok(s.samples && s.samples.ext && s.samples.ext.includes('tool.exe'), 'ext sampled');
assert.ok(s.samples['no-signal'] && s.samples['no-signal'].includes('daily.xlsx'), 'no-signal sampled');
assert.ok(!s.samples.personal, '개인 파일명은 표본에 저장하지 않는다'); // 프라이버시

console.log('work-file-uploader checks passed');
