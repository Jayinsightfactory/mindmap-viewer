'use strict';

const {
  getAppProfileKey,
  isClipboardNoise,
  normalizeAppName,
  sanitizeWindowTitle,
} = require('../src/data-quality');

describe('data-quality filters', () => {
  test('normalizes app names and aliases executable names', () => {
    expect(normalizeAppName('chrome.exe')).toBe('chrome');
    expect(normalizeAppName('msedge.exe')).toBe('edge');
    expect(normalizeAppName('nenova.exe')).toBe('nenova');
    expect(normalizeAppName('powershell.exe')).toBe('powershell');
    expect(normalizeAppName('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')).toBe('chrome');
  });

  test('rejects app-name contamination', () => {
    expect(normalizeAppName('{"events":[]}')).toBe('');
    expect(normalizeAppName('chrome,explorer,kakaotalk,excel')).toBe('');
    expect(normalizeAppName('powershell.exe -NoProfile Get-Process')).toBe('');
    expect(normalizeAppName('1.2.3.4')).toBe('');
  });

  test('sanitizes window titles without accepting process noise', () => {
    expect(sanitizeWindowTitle('chrome,explorer,kakaotalk,excel')).toBe('');
    expect(sanitizeWindowTitle('$env:TEMP | ConvertTo-Json')).toBe('');
    expect(sanitizeWindowTitle('견적서 test@example.com C:\\Users\\minsu\\Desktop\\quote.xlsx?token=abc')).toContain('[email]');
    expect(sanitizeWindowTitle('견적서 test@example.com C:\\Users\\minsu\\Desktop\\quote.xlsx?token=abc')).toContain('C:\\Users\\[user]\\');
    expect(sanitizeWindowTitle('견적서 test@example.com C:\\Users\\minsu\\Desktop\\quote.xlsx?token=abc')).toContain('?[params]');
  });

  test('filters clipboard system noise but keeps business text', () => {
    expect(isClipboardNoise('chrome')).toBe(true);
    expect(isClipboardNoise('매출분석.xlsx - Chrome')).toBe(true);
    expect(isClipboardNoise('chrome,explorer,kakaotalk,excel')).toBe(true);
    expect(isClipboardNoise('대한상사 견적 320만원 내일까지 부탁드립니다.')).toBe(false);
    expect(isClipboardNoise('품목\t수량\t단가\nA상품\t3\t12000\nB상품\t2\t8000')).toBe(false);
  });

  test('uses the same app key for capture profiles', () => {
    expect(getAppProfileKey('msedge.exe')).toBe('edge');
    expect(getAppProfileKey('nenova.exe')).toBe('nenova');
  });
});
