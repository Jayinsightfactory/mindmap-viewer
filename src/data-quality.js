'use strict';

const APP_ALIASES = {
  'chrome.exe': 'chrome',
  'google chrome': 'chrome',
  msedge: 'edge',
  'msedge.exe': 'edge',
  'microsoft edge': 'edge',
  'kakaotalk.exe': 'kakaotalk',
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
  'illustrator', 'kakaotalk', 'line', 'msedge', 'nenova', 'notepad',
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
};
