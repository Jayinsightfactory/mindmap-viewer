const { normalizeAppName, resolveAppName, isNumericAppName } = require('../../src/data-quality');

describe('numeric app name guard', () => {
  test('numeric app is rejected (keeps fallback)', () => {
    expect(normalizeAppName('15', 'chrome')).toBe('chrome');
    expect(normalizeAppName('6361701505')).toBe('');
    expect(isNumericAppName(' 141 ')).toBe(true);
  });
  test('normal names unchanged', () => {
    expect(normalizeAppName('chrome')).toBe('chrome');
    expect(resolveAppName('kakaotalk', 'x')).toBe('kakaotalk');
  });
  test('resolve from title or unknown', () => {
    expect(resolveAppName('15', '141 KakaoTalk 대화')).toBe('kakaotalk');
    expect(resolveAppName('6361701505', '{"workbook":"a.xlsx"}')).toBe('excel');
    expect(resolveAppName('', '')).toBe('unknown');
  });
});

describe('vision dedup key', () => {
  const { _dedupKey } = require('../../bin/vision-worker');
  test('normal app key unchanged', () => expect(_dedupKey('u', 'chrome', 't')).toBe('u|chrome'));
  test('numeric app uses title', () => {
    expect(_dedupKey('u', '15', '31 KakaoTalk 방')).toBe('u|kakaotalk');
    expect(_dedupKey('u', '15', 'Chrome 탭')).not.toBe(_dedupKey('u', '15', '31 KakaoTalk 방'));
  });
});

describe('win-shell per-command sentinel', () => {
  test('stale output of timed-out command is discarded', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/win-shell.js'), 'utf8');
    expect(src).toMatch(/SENTINEL\}\$\{seq\}__/);
    expect(src).toMatch(/!== _pending\.seq\) continue/);
  });
});
