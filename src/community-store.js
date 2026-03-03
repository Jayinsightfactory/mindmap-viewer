/**
 * src/community-store.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 커뮤니티 게시판 파일 기반 영속성 스토어
 *
 * 데이터는 JSON 파일(data/community.json)에 저장됩니다.
 * 게시물 목록과 각 게시물의 답변이 중첩 구조로 저장됩니다.
 *
 * 게시물(Post) 스키마:
 *   id:        string    - 고유 ID (자동 생성: 'p-<base36>')
 *   title:     string    - 제목
 *   body:      string    - 내용 (Markdown 허용)
 *   category:  string    - 'question' | 'insight' | 'showcase' | 'feedback'
 *   author:    string    - 작성자 이름/ID
 *   tags:      string[]  - 태그 목록 (중복 감지용)
 *   votes:     number    - 추천 수 (음수 가능)
 *   answered:  boolean   - 채택된 답변 존재 여부
 *   answers:   Answer[]  - 답변 목록 (중첩)
 *   createdAt: string    - ISO 날짜 (YYYY-MM-DD)
 *
 * 답변(Answer) 스키마:
 *   id:        string    - 고유 ID (자동 생성: 'ans-<base36>')
 *   body:      string    - 답변 내용 (Markdown 허용)
 *   author:    string    - 작성자 이름/ID
 *   votes:     number    - 추천 수
 *   accepted:  boolean   - 채택된 답변 여부
 *   createdAt: string    - ISO 날짜 (YYYY-MM-DD)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/** community.json 파일 경로 */
const COMM_FILE = path.join(__dirname, '..', 'data', 'community.json');

// ── 내부 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * community.json 을 읽어 반환합니다.
 * 파일이 없거나 파싱 오류 시 기본 구조 { posts: [] } 를 반환합니다.
 * @returns {{ posts: Post[] }}
 */
function _load() {
  try {
    if (!fs.existsSync(COMM_FILE)) return { posts: [] };
    return JSON.parse(fs.readFileSync(COMM_FILE, 'utf8'));
  } catch {
    return { posts: [] };
  }
}

/**
 * 데이터를 community.json 에 저장합니다.
 * data/ 디렉토리가 없으면 자동으로 생성합니다.
 * @param {{ posts: Post[] }} data
 */
function _save(data) {
  const dir = path.dirname(COMM_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(COMM_FILE, JSON.stringify(data, null, 2));
}

// ── 게시물 CRUD ──────────────────────────────────────────────────────────────

/**
 * 전체 게시물 목록을 반환합니다.
 * @returns {Post[]}
 */
function getPosts() {
  return _load().posts;
}

/**
 * 새 게시물을 등록합니다.
 * @param {Partial<Post>} post - 게시물 데이터 (title, body, category, author, tags 등)
 * @returns {Post} 저장된 게시물 (id, votes, answers, createdAt 포함)
 */
function addPost(post) {
  const data  = _load();
  const entry = {
    ...post,
    id:        'p-' + Date.now().toString(36),
    votes:     0,
    answered:  false,
    answers:   [],
    tags:      Array.isArray(post.tags) ? post.tags : [],
    createdAt: new Date().toISOString().slice(0, 10),
  };
  data.posts.push(entry);
  _save(data);
  return entry;
}

// ── 답변 CRUD ────────────────────────────────────────────────────────────────

/**
 * 게시물에 답변을 추가합니다.
 * 답변이 추가되면 게시물의 answered 플래그가 true 로 설정됩니다.
 * @param {string}         postId - 대상 게시물 ID
 * @param {Partial<Answer>} answer - 답변 데이터 (body, author 등)
 * @returns {Answer | null} 저장된 답변, 게시물이 없으면 null
 */
function addAnswer(postId, answer) {
  const data = _load();
  const post = data.posts.find(p => p.id === postId);
  if (!post) return null;

  if (!post.answers) post.answers = [];

  const entry = {
    ...answer,
    id:        'ans-' + Date.now().toString(36),
    votes:     0,
    accepted:  false,
    createdAt: new Date().toISOString().slice(0, 10),
  };
  post.answers.push(entry);
  post.answered = true;
  _save(data);
  return entry;
}

/**
 * 답변을 '채택된 답변'으로 표시합니다.
 * 기존 채택 답변이 있으면 자동으로 해제됩니다.
 * @param {string} postId   - 게시물 ID
 * @param {string} answerId - 채택할 답변 ID
 * @returns {boolean} 성공 여부
 */
function acceptAnswer(postId, answerId) {
  const data = _load();
  const post = data.posts.find(p => p.id === postId);
  if (!post || !post.answers) return false;

  // 기존 채택 해제 후 새 채택 설정
  post.answers.forEach(a => { a.accepted = (a.id === answerId); });
  _save(data);
  return true;
}

// ── 투표 ─────────────────────────────────────────────────────────────────────

/**
 * 게시물에 추천/비추천 투표를 적용합니다.
 * @param {string} postId    - 게시물 ID
 * @param {'up'|'down'} direction - 투표 방향
 */
function votePost(postId, direction) {
  const data = _load();
  const post = data.posts.find(p => p.id === postId);
  if (post) {
    post.votes = (post.votes || 0) + (direction === 'up' ? 1 : -1);
    _save(data);
  }
}

/**
 * 답변에 추천/비추천 투표를 적용합니다.
 * @param {string} postId    - 게시물 ID
 * @param {string} answerId  - 답변 ID
 * @param {'up'|'down'} direction - 투표 방향
 */
function voteAnswer(postId, answerId, direction) {
  const data   = _load();
  const post   = data.posts.find(p => p.id === postId);
  const answer = post?.answers?.find(a => a.id === answerId);
  if (answer) {
    answer.votes = (answer.votes || 0) + (direction === 'up' ? 1 : -1);
    _save(data);
  }
}

// ── 중복 감지 ─────────────────────────────────────────────────────────────────

/**
 * 새 게시물과 태그가 겹치는 기존 답변 완료 게시물을 찾습니다.
 * 커뮤니티 게시판의 '중복 질문 자동 감지' 기능에 사용됩니다.
 * 태그 교집합이 2개 이상이고 이미 answered 상태인 게시물을 반환합니다.
 *
 * @param {string[]} tags - 새 게시물의 태그 목록
 * @returns {Post[]} 유사 게시물 목록 (최대 3개, 추천 수 내림차순)
 */
function findSimilar(tags) {
  if (!tags || tags.length === 0) return [];
  const posts = _load().posts;
  return posts
    .filter(p => {
      if (!p.answered) return false;
      const overlap = (p.tags || []).filter(t => tags.includes(t));
      return overlap.length >= 2;
    })
    .sort((a, b) => (b.votes || 0) - (a.votes || 0))
    .slice(0, 3);
}

module.exports = { getPosts, addPost, addAnswer, acceptAnswer, votePost, voteAnswer, findSimilar };
