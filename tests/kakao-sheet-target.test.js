'use strict';
const {
  ARCHIVE_KAKAO_SHEET_ID,
  DEFAULT_KAKAO_SHEET_ID,
  extractSheetId,
  resolveKakaoSheetIds,
} = require('../src/kakao-sheet-target');

test('기본은 2호를 먼저 읽고 1호를 아카이브로 함께 남긴다', () => {
  expect(DEFAULT_KAKAO_SHEET_ID).toBe('1x7kGxLMOgHcf4_120vDXRa77-2Pi3VKXs2NlBe-4dAE');
  expect(ARCHIVE_KAKAO_SHEET_ID).toBe('1pXLVZqiMwWt6Vh0IhWwASBvgLtZqLnbHXMWqOLNwAXU');
  expect(resolveKakaoSheetIds({})).toEqual([DEFAULT_KAKAO_SHEET_ID, ARCHIVE_KAKAO_SHEET_ID]);
});

test('KAKAO_SHEET_ID 는 URL 이든 ID 든 기본값을 이긴다', () => {
  expect(resolveKakaoSheetIds({ KAKAO_SHEET_ID: 'sheet-by-env' }))
    .toEqual(['sheet-by-env', ARCHIVE_KAKAO_SHEET_ID]);
  expect(resolveKakaoSheetIds({
    KAKAO_SHEET_ID: `https://docs.google.com/spreadsheets/d/${ARCHIVE_KAKAO_SHEET_ID}/edit#gid=0`,
  })).toEqual([ARCHIVE_KAKAO_SHEET_ID]);
});

test('KAKAO_SHEET_ID 가 없을 때만 GOOGLE_SHEET_URL 을 쓴다', () => {
  expect(resolveKakaoSheetIds({ GOOGLE_SHEET_URL: 'https://docs.google.com/spreadsheets/d/url-sheet-1/edit' }))
    .toEqual(['url-sheet-1', ARCHIVE_KAKAO_SHEET_ID]);
  expect(resolveKakaoSheetIds({ KAKAO_SHEET_ID: 'primary-1', GOOGLE_SHEET_URL: 'url-sheet-1' }))
    .toEqual(['primary-1', ARCHIVE_KAKAO_SHEET_ID]);
});

test('보관 시트를 따로 지정할 수 있고, 대상과 같으면 되돌아 읽지 않는다', () => {
  expect(resolveKakaoSheetIds({ KAKAO_ARCHIVE_SHEET_ID: 'archive-2' }))
    .toEqual([DEFAULT_KAKAO_SHEET_ID, 'archive-2']);
  expect(resolveKakaoSheetIds({ KAKAO_SHEET_ID: 'same-1', KAKAO_ARCHIVE_SHEET_ID: 'same-1' }))
    .toEqual(['same-1']);
});

test('extractSheetId 는 URL 에서 ID 만 뽑고 ID 는 그대로 둔다', () => {
  expect(extractSheetId('https://docs.google.com/spreadsheets/d/abc123/edit?usp=sharing')).toBe('abc123');
  expect(extractSheetId('  abc123  ')).toBe('abc123');
  expect(extractSheetId('')).toBe('');
  expect(extractSheetId(null)).toBe('');
});
