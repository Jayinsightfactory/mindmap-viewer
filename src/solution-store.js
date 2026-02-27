/**
 * src/solution-store.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 솔루션 마켓 파일 기반 영속성 스토어
 *
 * 솔루션은 JSON 파일(data/solutions.json)에 저장됩니다.
 * 별도 DB 없이 운영 가능하며, 고가용성이 필요하면 DB 스토어로 교체 가능합니다.
 *
 * 솔루션 스키마:
 *   id:          string   - 고유 ID (자동 생성: 'sol-<base36>')
 *   type:        string   - 'automation' | 'workflow' | 'agent' | 'alias' | 'checklist' | 'refactor'
 *   title:       string   - 솔루션 이름
 *   description: string   - 상세 설명
 *   author:      string   - 작성자 이름/ID
 *   tags:        string[] - 태그 목록 (검색/필터용)
 *   price:       number   - 가격 (0 = 무료)
 *   downloads:   number   - 다운로드 수
 *   rating:      number   - 평균 평점 (0~5)
 *   ratingCount: number   - 평점 참여 수
 *   confidence:  number   - 자동 추천 신뢰도 (0~1, growth-engine 연동)
 *   upvotes:     number   - 추천 수
 *   source:      string   - 출처 ('user' | 'orbit' | 'market')
 *   createdAt:   string   - ISO 날짜 (YYYY-MM-DD)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/** solutions.json 파일 경로 */
const SOLUTIONS_FILE = path.join(__dirname, '..', 'data', 'solutions.json');

// ── 내부 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * solutions.json 을 읽어 배열로 반환합니다.
 * 파일이 없거나 파싱 오류 시 빈 배열을 반환합니다.
 * @returns {Solution[]}
 */
function _load() {
  try {
    if (!fs.existsSync(SOLUTIONS_FILE)) return [];
    return JSON.parse(fs.readFileSync(SOLUTIONS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * 데이터 배열을 solutions.json 에 저장합니다.
 * data/ 디렉토리가 없으면 자동으로 생성합니다.
 * @param {Solution[]} data
 */
function _save(data) {
  const dir = path.dirname(SOLUTIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SOLUTIONS_FILE, JSON.stringify(data, null, 2));
}

// ── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * 전체 솔루션 목록을 반환합니다.
 * @returns {Solution[]}
 */
function getAll() {
  return _load();
}

/**
 * 새 솔루션을 등록합니다.
 * id 가 없으면 자동 생성합니다.
 * @param {Partial<Solution>} sol - 등록할 솔루션 데이터
 * @returns {Solution} 저장된 솔루션 (id, createdAt 포함)
 */
function add(sol) {
  const data  = _load();
  const entry = {
    ...sol,
    id:          sol.id || 'sol-' + Date.now().toString(36),
    downloads:   sol.downloads   || 0,
    rating:      sol.rating      || 0,
    ratingCount: sol.ratingCount || 0,
    upvotes:     sol.upvotes     || 0,
    confidence:  sol.confidence  || 0,
    createdAt:   new Date().toISOString().slice(0, 10),
  };
  data.push(entry);
  _save(data);
  return entry;
}

/**
 * 솔루션의 다운로드 수를 1 증가시킵니다.
 * @param {string} id - 솔루션 ID
 */
function recordDownload(id) {
  const data = _load();
  const sol  = data.find(s => s.id === id);
  if (sol) {
    sol.downloads = (sol.downloads || 0) + 1;
    _save(data);
  }
}

/**
 * 솔루션에 평점을 등록하고 누적 평균을 업데이트합니다.
 * @param {string} id     - 솔루션 ID
 * @param {number} rating - 평점 (1~5)
 * @returns {Solution | null}
 */
function rateSolution(id, rating) {
  const data = _load();
  const sol  = data.find(s => s.id === id);
  if (!sol) return null;

  const count    = (sol.ratingCount || 0) + 1;
  const prev     = (sol.rating || 0) * (sol.ratingCount || 0);
  sol.rating      = parseFloat(((prev + rating) / count).toFixed(2));
  sol.ratingCount = count;
  _save(data);
  return sol;
}

/**
 * 솔루션을 삭제합니다.
 * @param {string} id - 삭제할 솔루션 ID
 */
function remove(id) {
  const data = _load().filter(s => s.id !== id);
  _save(data);
}

module.exports = { getAll, add, recordDownload, rateSolution, remove };
