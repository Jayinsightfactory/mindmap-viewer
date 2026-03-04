/**
 * src/avatar-store.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 아바타/캐릭터 프로필 스토어
 *
 * 지원 타입:
 *   image      — 정적 이미지 (JPG/PNG/WebP)
 *   gif        — 애니메이션 GIF
 *   video      — 짧은 영상 (MP4, 최대 10초)
 *   svg_anim   — SVG 애니메이션 (가장 가벼움)
 *   character  — JSON 기반 캐릭터 설정 (3D 연동)
 *   comic      — 만화 스타일 이미지
 *   voxel      — 픽셀/복셀 아트
 *
 * 데이터: data/avatars.json (JSON 파일 기반, 사용자 수 적을 때 적합)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const AVATAR_FILE = path.join(DATA_DIR, 'avatars.json');

// ─── 지원 타입 ────────────────────────────────────────────────────────────────
const AVATAR_TYPES = ['image', 'gif', 'video', 'svg_anim', 'character', 'comic', 'voxel'];

const ALLOWED_EXTENSIONS = {
  image:     ['.jpg', '.jpeg', '.png', '.webp', '.avif'],
  gif:       ['.gif'],
  video:     ['.mp4', '.webm'],
  svg_anim:  ['.svg'],
  character: ['.json'],
  comic:     ['.jpg', '.jpeg', '.png', '.webp'],
  voxel:     ['.png', '.json'],
};

// ─── 스토어 로드/저장 ────────────────────────────────────────────────────────
function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(AVATAR_FILE)) return { avatars: [], profiles: {} };
  try {
    return JSON.parse(fs.readFileSync(AVATAR_FILE, 'utf8'));
  } catch {
    return { avatars: [], profiles: {} };
  }
}

function save(data) {
  fs.writeFileSync(AVATAR_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ─── 유틸 ────────────────────────────────────────────────────────────────────
function ulid() {
  return 'av_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// ─── 아바타 CRUD ─────────────────────────────────────────────────────────────

/**
 * 새 아바타를 등록합니다.
 *
 * @param {object} params
 * @param {string} params.userId   - 소유자 ID
 * @param {string} params.type     - AVATAR_TYPES 중 하나
 * @param {string} params.url      - 에셋 URL (업로드 경로 or 외부 URL)
 * @param {string} [params.name]   - 아바타 이름 (마켓 표시용)
 * @param {boolean} [params.isPublic] - 마켓에 공개 여부 (기본 false)
 * @param {number} [params.price]  - 가격 (Orbit 코인, 0 = 무료)
 * @param {string[]} [params.tags] - 검색 태그
 * @param {string} [params.thumbnail] - 미리보기 URL
 * @returns {{ ok: boolean, avatar?: object, error?: string }}
 */
function registerAvatar({ userId, type, url, name, isPublic = false, price = 0, tags = [], thumbnail }) {
  if (!userId || !type || !url) return { error: 'userId, type, url required' };
  if (!AVATAR_TYPES.includes(type)) return { error: `Invalid type. Must be one of: ${AVATAR_TYPES.join(', ')}` };
  if (price < 0) return { error: 'price must be >= 0' };

  const data   = load();
  const avatar = {
    id:        ulid(),
    userId,
    type,
    url,
    thumbnail: thumbnail || url,
    name:      name || `${type}_${Date.now()}`,
    isPublic:  Boolean(isPublic),
    price:     Number(price) || 0,
    tags:      Array.isArray(tags) ? tags.slice(0, 10) : [],
    downloads: 0,
    rating:    0,
    ratingCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  data.avatars.push(avatar);
  save(data);
  return { ok: true, avatar };
}

/**
 * 사용자의 활성 프로필 아바타를 설정합니다.
 *
 * @param {string} userId
 * @param {string} avatarId
 * @returns {{ ok: boolean, error?: string }}
 */
function setActiveAvatar(userId, avatarId) {
  const data   = load();
  const avatar = data.avatars.find(a => a.id === avatarId);
  if (!avatar) return { error: 'Avatar not found' };
  if (avatar.userId !== userId && avatar.price > 0 && !isPurchased(data, userId, avatarId)) {
    return { error: 'Avatar not owned' };
  }
  if (!data.profiles) data.profiles = {};
  data.profiles[userId] = avatarId;
  save(data);
  return { ok: true };
}

/**
 * 사용자의 활성 아바타를 조회합니다.
 *
 * @param {string} userId
 * @returns {object|null}
 */
function getActiveAvatar(userId) {
  const data = load();
  const avatarId = data.profiles?.[userId];
  if (!avatarId) return null;
  return data.avatars.find(a => a.id === avatarId) || null;
}

/**
 * 아바타 마켓 목록 조회 (공개된 아바타만)
 *
 * @param {{ type?, tags?, userId?, limit?, offset? }} filters
 * @returns {object[]}
 */
function listMarketAvatars({ type, tags, userId, limit = 20, offset = 0 } = {}) {
  const data = load();
  let list = data.avatars.filter(a => a.isPublic);

  if (type)   list = list.filter(a => a.type === type);
  if (userId) list = list.filter(a => a.userId === userId);
  if (tags && tags.length > 0) {
    list = list.filter(a => tags.some(t => a.tags?.includes(t)));
  }

  // 인기순 (다운로드 + 평점) 정렬
  list.sort((a, b) => (b.downloads * 0.3 + b.rating * 10) - (a.downloads * 0.3 + a.rating * 10));

  return list.slice(offset, offset + limit);
}

/**
 * 사용자 본인의 아바타 목록 조회
 *
 * @param {string} userId
 * @returns {object[]}
 */
function getUserAvatars(userId) {
  const data = load();
  return data.avatars.filter(a => a.userId === userId);
}

/**
 * 아바타 다운로드 수 증가 (마켓 무료 아이템 다운로드 시)
 *
 * @param {string} avatarId
 * @returns {{ ok: boolean }}
 */
function recordAvatarDownload(avatarId) {
  const data   = load();
  const avatar = data.avatars.find(a => a.id === avatarId);
  if (!avatar) return { ok: false };
  avatar.downloads = (avatar.downloads || 0) + 1;
  save(data);
  return { ok: true };
}

/**
 * 아바타 평점 누적 평균 갱신
 *
 * @param {string} avatarId
 * @param {number} rating   - 1~5
 * @returns {{ ok: boolean, newRating?: number }}
 */
function rateAvatar(avatarId, rating) {
  if (rating < 1 || rating > 5) return { ok: false, error: 'rating must be 1-5' };
  const data   = load();
  const avatar = data.avatars.find(a => a.id === avatarId);
  if (!avatar) return { ok: false, error: 'not found' };

  avatar.ratingCount = (avatar.ratingCount || 0) + 1;
  avatar.rating = (avatar.rating * (avatar.ratingCount - 1) + rating) / avatar.ratingCount;
  avatar.updatedAt = new Date().toISOString();
  save(data);
  return { ok: true, newRating: Math.round(avatar.rating * 10) / 10 };
}

/**
 * 아바타 삭제 (본인 소유만 가능)
 *
 * @param {string} userId
 * @param {string} avatarId
 * @returns {{ ok: boolean, error?: string }}
 */
function deleteAvatar(userId, avatarId) {
  const data = load();
  const idx  = data.avatars.findIndex(a => a.id === avatarId && a.userId === userId);
  if (idx === -1) return { error: 'not found or not owner' };
  data.avatars.splice(idx, 1);
  // 활성 프로필이면 초기화
  if (data.profiles?.[userId] === avatarId) delete data.profiles[userId];
  save(data);
  return { ok: true };
}

// ─── 구매 여부 확인 (향후 코인 시스템 연동 시 확장) ──────────────────────────
function isPurchased(data, userId, avatarId) {
  // TODO: 코인 결제 시스템 연동 후 구현
  // 현재는 userId === avatar.userId 또는 price === 0이면 허용
  const avatar = data.avatars.find(a => a.id === avatarId);
  return avatar && (avatar.userId === userId || avatar.price === 0);
}

module.exports = {
  AVATAR_TYPES,
  ALLOWED_EXTENSIONS,
  registerAvatar,
  setActiveAvatar,
  getActiveAvatar,
  listMarketAvatars,
  getUserAvatars,
  recordAvatarDownload,
  rateAvatar,
  deleteAvatar,
};
