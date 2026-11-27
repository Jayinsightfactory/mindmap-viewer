'use strict';
/**
 * 카톡 분석 시트(구글 스프레드시트) 읽기 대상 고르기.
 *
 * 1호 '네노바 AI 학습 데이터' 는 할당 셀이 1천만 상한의 96.5%까지 차서 더는 쓰지 않는다(보관용).
 * 새 데이터는 2호 '네노바 AI 학습 데이터 2호' 로 가고, 운영 PC(nenovakakao) 쪽 업로더가
 * .env 의 GSHEET_TARGET_SPREADSHEET_ID 로 2호를 가리킨다.
 *
 * 2호로 막 넘어온 때는 2호 탭에 헤더만 있고 데이터가 없다. 그 구간에 화면이 비지 않도록
 * 읽는 쪽은 [2호, 1호] 순서로 시도하고, 2호에서 읽은 행이 없으면 1호를 읽는다.
 *
 * 환경변수
 *   KAKAO_SHEET_ID          대상 시트 ID 또는 URL (없으면 2호)
 *   GOOGLE_SHEET_URL        KAKAO_SHEET_ID 가 없을 때만 쓰는 기존 이름
 *   KAKAO_ARCHIVE_SHEET_ID  되돌아 읽을 보관 시트 (없으면 1호). 대상과 같으면 되돌아 읽지 않는다.
 */

// 1호(아카이브)
const ARCHIVE_KAKAO_SHEET_ID = '1pXLVZqiMwWt6Vh0IhWwASBvgLtZqLnbHXMWqOLNwAXU';
// 2호(현재)
const DEFAULT_KAKAO_SHEET_ID = '1x7kGxLMOgHcf4_120vDXRa77-2Pi3VKXs2NlBe-4dAE';

function extractSheetId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/\/spreadsheets\/d\/([^/]+)/);
  return match ? match[1] : raw;
}

function resolveKakaoSheetIds(env = process.env) {
  const primary = extractSheetId(env.KAKAO_SHEET_ID || env.GOOGLE_SHEET_URL) || DEFAULT_KAKAO_SHEET_ID;
  const archive = extractSheetId(env.KAKAO_ARCHIVE_SHEET_ID) || ARCHIVE_KAKAO_SHEET_ID;
  return archive && archive !== primary ? [primary, archive] : [primary];
}

module.exports = {
  ARCHIVE_KAKAO_SHEET_ID,
  DEFAULT_KAKAO_SHEET_ID,
  extractSheetId,
  resolveKakaoSheetIds,
};
