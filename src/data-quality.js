'use strict';

const APP_ALIASES = {
  'chrome.exe': 'chrome',
  'google chrome': 'chrome',
  msedge: 'edge',
  'msedge.exe': 'edge',
  'microsoft edge': 'edge',
  'kakaotalk.exe': 'kakaotalk',
  'kakaowork.exe': 'kakaowork',
  'kakaowork': 'kakaowork',
  'nenova.exe': 'nenova',
  'excel.exe': 'excel',
  winword: 'word',
  'winword.exe': 'word',
  'word.exe': 'word',
  'powerpnt.exe': 'powerpnt',
  'powerpoint.exe': 'powerpnt',
  'code.exe': 'code',
  'cursor.exe': 'cursor',
  'explorer.exe': 'explorer',
};

const KNOWN_PROCESS_NAMES = new Set([
  'applicationframehost', 'brave', 'calculator', 'chrome', 'cmd', 'code',
  'cursor', 'discord', 'edge', 'excel', 'explorer', 'firefox', 'hwp',
  'illustrator', 'kakaotalk', 'kakaowork', 'line', 'msedge', 'nenova', 'notepad',
  'notion', 'obsidian', 'photoshop', 'powerpnt', 'powershell', 'pycharm',
  'rider', 'slack', 'teams', 'telegram', 'terminal', 'whale', 'winword',
  'word', 'zoom',
]);

function _stringify(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).replace(/^\uFEFF/, '').trim();
}

function compactWhitespace(raw) {
  return _stringify(raw).replace(/\s+/g, ' ').trim();
}

function _baseProcessName(raw) {
  let s = compactWhitespace(raw);
  if (!s) return '';
  s = s.replace(/^.*[\\/]/, '');
  const lowered = s.toLowerCase();
  return APP_ALIASES[lowered] || lowered.replace(/\.(exe|app)$/i, '');
}

function looksLikePowerShellCommand(raw) {
  const s = _stringify(raw);
  if (!s) return false;
  return /\$env:|powershell(?:\.exe)?\s+[-/]|irm\s+https?:|iwr\s+https?:|get-process|select-object|where-object|add-type|system\.text|console\]::|convertto-json/i.test(s);
}

function looksLikeJsonNoise(raw) {
  const s = _stringify(raw);
  if (!s || s.length < 2) return false;
  if (!((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']')))) return false;
  if (/(^|["'])events["']|["']version["']|["']process/i.test(s)) return true;
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.length > 2 && parsed.every(v => typeof v === 'string');
    if (parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed);
      return keys.length > 0 && keys.some(k => /events|version|process|clipboard|window|powershell/i.test(k));
    }
  } catch {}
  return false;
}

function looksLikeVersion(raw) {
  const s = compactWhitespace(raw);
  return /^v?\d+(?:\.\d+){1,5}(?:[-+][a-z0-9._-]+)?$/i.test(s);
}

function looksLikeProcessList(raw) {
  const s = compactWhitespace(raw);
  if (!s.includes(',')) return false;
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length < 4) return false;
  const processLike = parts.filter(p => /^[a-zA-Z][a-zA-Z0-9._ -]{0,40}$/.test(p));
  if (processLike.length !== parts.length) return false;
  const knownCount = parts.filter(p => KNOWN_PROCESS_NAMES.has(_baseProcessName(p))).length;
  return knownCount >= 2 || parts.every(p => !/\s/.test(p) && p.length <= 24);
}

function looksLikeWindowTitleNoise(raw) {
  const s = compactWhitespace(raw);
  if (!s) return false;
  return /^.{2,140}\s+[-–]\s+(Chrome|Microsoft Edge|Microsoft Excel|Microsoft Word|Edge|Firefox|Opera|Whale|Slack|Teams)$/i.test(s);
}

function normalizeAppName(raw, fallback = '') {
  const s = compactWhitespace(raw);
  if (!s) return fallback || '';
  // [2026-11-03] 순수 숫자(유휴ms·PID·창핸들 등)는 앱명이 아님 — win-shell 응답 밀림으로 '15','6361701505' 가 들어왔음
  if (/^\d+$/.test(s)) return fallback || '';
  if (s.length > 80) return fallback || '';
  if (looksLikeJsonNoise(s) || looksLikeProcessList(s) || looksLikePowerShellCommand(s) || looksLikeVersion(s)) {
    return fallback || '';
  }
  if (/[\r\n\t]/.test(_stringify(raw))) return fallback || '';

  const base = _baseProcessName(s);
  const alias = APP_ALIASES[base] || base;
  if (!/^[a-z0-9][a-z0-9._ -]{0,80}$/.test(alias)) return fallback || '';
  return alias;
}

function sanitizeWindowTitle(raw, fallback = '') {
  let s = compactWhitespace(raw);
  if (!s) return fallback || '';
  if (s.length > 500) return fallback || '';
  if (looksLikeJsonNoise(s) || looksLikeProcessList(s) || looksLikePowerShellCommand(s)) return fallback || '';
  s = s.replace(/[\w.-]+@[\w.-]+/g, '[email]');
  s = s.replace(/\?[^\s]*/g, '?[params]');
  s = s.replace(/\/Users\/[\w.-]+\//g, '/Users/[user]/');
  s = s.replace(/C:\\Users\\[\w.-]+\\/gi, 'C:\\Users\\[user]\\');
  // [2026-09-29 개인정보 게이트] 개인 용도 창제목(검색·쇼핑·유튜브 등)은 '[개인]'으로 치환
  try { s = require('./privacy-gate').redactTitleIfPersonal(s); } catch {}
  return s.slice(0, 200);
}

function isClipboardNoise(raw) {
  const s = compactWhitespace(raw);
  if (!s) return true;
  if (looksLikeProcessList(s) || looksLikePowerShellCommand(s) || looksLikeWindowTitleNoise(s)) return true;
  if (looksLikeJsonNoise(s)) return true;

  const normalized = normalizeAppName(s);
  if (normalized && KNOWN_PROCESS_NAMES.has(normalized) && s.split(/\s+/).length <= 2) return true;
  return false;
}

// [2026-11-03] 앱명이 비었거나 숫자면 창제목으로 판별, 그래도 모르면 'unknown'. 정상 앱명은 그대로.
const TITLE_APP_RULES = [
  [/kakaotalk|카카오톡/i, 'kakaotalk'],
  [/chrome/i, 'chrome'],
  [/microsoft edge/i, 'msedge'],
  [/excel|\.xls[xm]?\b|"workbook"/i, 'excel'],
  [/nenova|네노바/i, 'nenova'],
];
function isNumericAppName(raw) { return /^\s*\d+\s*$/.test(String(raw == null ? '' : raw)); }
function appFromWindowTitle(title) {
  const t = String(title || '');
  for (const [re, app] of TITLE_APP_RULES) if (re.test(t)) return app;
  return '';
}
function resolveAppName(app, windowTitle) {
  const n = normalizeAppName(app, '');
  if (n) return n;
  return appFromWindowTitle(windowTitle) || 'unknown';
}

function getAppProfileKey(raw) {
  return normalizeAppName(raw, '');
}

module.exports = {
  compactWhitespace,
  getAppProfileKey,
  isClipboardNoise,
  looksLikeJsonNoise,
  looksLikePowerShellCommand,
  looksLikeProcessList,
  looksLikeWindowTitleNoise,
  normalizeAppName,
  sanitizeWindowTitle,
  isNumericAppName,
  appFromWindowTitle,
  resolveAppName,
};
