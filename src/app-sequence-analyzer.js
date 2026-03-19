'use strict';
// app-sequence-analyzer.js — 앱 전환 시퀀스 분석
// 앱 전환 기록 → n-gram 분석 → 반복 워크플로우 감지

let _sequence = []; // 최근 앱 전환 기록
const MAX_SEQUENCE = 200;
let _patterns = {}; // 감지된 패턴

function recordAppSwitch(appName, windowTitle) {
  const entry = { app: appName, title: windowTitle, ts: Date.now() };
  _sequence.push(entry);
  if (_sequence.length > MAX_SEQUENCE) _sequence.shift();

  // 3-gram, 4-gram 분석
  _analyzeNgrams();
}

function _analyzeNgrams() {
  if (_sequence.length < 4) return;

  const apps = _sequence.map(s => s.app).filter(Boolean);

  // 3-gram
  for (let i = 0; i <= apps.length - 3; i++) {
    const key = apps.slice(i, i + 3).join('→');
    _patterns[key] = (_patterns[key] || 0) + 1;
  }

  // 4-gram
  for (let i = 0; i <= apps.length - 4; i++) {
    const key = apps.slice(i, i + 4).join('→');
    _patterns[key] = (_patterns[key] || 0) + 1;
  }
}

// 반복 패턴 가져오기 (3회 이상 반복된 것만)
function getRepeatingPatterns(minCount = 3) {
  return Object.entries(_patterns)
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .map(([pattern, count]) => ({ pattern, count, apps: pattern.split('→') }));
}

function getSequence() { return _sequence.slice(-50); }
function reset() { _sequence = []; _patterns = {}; }

module.exports = { recordAppSwitch, getRepeatingPatterns, getSequence, reset };
