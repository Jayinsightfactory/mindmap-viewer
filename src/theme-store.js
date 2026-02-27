/**
 * theme-store.js
 * 테마 저장소 — 기본 내장 테마 + 사용자 등록 테마 관리
 */
const fs   = require('fs');
const path = require('path');

const THEMES_FILE = path.join(__dirname, '..', 'data', 'themes.json');

// ─── 기본 내장 테마 ──────────────────────────────
const BUILTIN_THEMES = [
  {
    id: 'space-dark',
    name: 'Space Dark',
    description: '기본 우주 테마. 깊고 어두운 배경에 은은한 컬러.',
    author: 'Orbit',
    authorId: 'orbit',
    price: 0,
    tags: ['dark', 'default', 'space'],
    downloads: 0,
    rating: 5.0,
    builtin: true,
    preview: '#060a10',
    vars: {
      '--bg': '#060a10', '--bg2': '#0d1117', '--bg3': '#161b22',
      '--text': '#f0f6fc', '--text2': '#c9d1d9', '--text3': '#8b949e',
      '--blue': '#58a6ff', '--green': '#3fb950', '--purple': '#bc8cff',
      '--orange': '#ffa657', '--cyan': '#39d2c0', '--pink': '#f778ba',
      '--accent': '#8957e5',
      '--node-glow': '0 0 18px rgba(137,87,229,0.4)',
      '--font': "'Inter', sans-serif",
    },
    canvas: {
      bgColor: '#060a10',
      gridColor: 'rgba(48,54,61,0.15)',
      edgeColor: 'rgba(88,166,255,0.25)',
    },
    createdAt: '2024-01-01',
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    description: '네온 글로우, 검정+노랑+핫핑크. AI 행성계의 진짜 미래.',
    author: 'Orbit',
    authorId: 'orbit',
    price: 0,
    tags: ['dark', 'neon', 'cyberpunk', 'featured'],
    downloads: 0,
    rating: 4.9,
    builtin: true,
    preview: '#0a0a0f',
    vars: {
      '--bg': '#0a0a0f', '--bg2': '#10101a', '--bg3': '#1a1a2e',
      '--text': '#f0f0ff', '--text2': '#b0b0d0', '--text3': '#6060a0',
      '--blue': '#00d4ff', '--green': '#00ff88', '--purple': '#cc00ff',
      '--orange': '#ff6600', '--cyan': '#00ffcc', '--pink': '#ff0080',
      '--accent': '#ffee00',
      '--node-glow': '0 0 24px rgba(255,238,0,0.5)',
      '--font': "'Share Tech Mono', 'Courier New', monospace",
    },
    canvas: {
      bgColor: '#0a0a0f',
      gridColor: 'rgba(255,238,0,0.06)',
      edgeColor: 'rgba(0,212,255,0.35)',
      glowEffect: true,
    },
    createdAt: '2024-01-01',
  },
  {
    id: 'terminal-green',
    name: 'Terminal Green',
    description: 'CRT 모니터 감성. 클래식 해커 그린.',
    author: 'Orbit',
    authorId: 'orbit',
    price: 0,
    tags: ['dark', 'terminal', 'retro', 'monospace'],
    downloads: 0,
    rating: 4.7,
    builtin: true,
    preview: '#000800',
    vars: {
      '--bg': '#000800', '--bg2': '#001200', '--bg3': '#001a00',
      '--text': '#00ff41', '--text2': '#00cc33', '--text3': '#008020',
      '--blue': '#00ff41', '--green': '#00ff41', '--purple': '#00dd33',
      '--orange': '#88ff00', '--cyan': '#00ffaa', '--pink': '#00ff88',
      '--accent': '#00ff41',
      '--node-glow': '0 0 20px rgba(0,255,65,0.6)',
      '--font': "'Share Tech Mono', 'Courier New', monospace",
    },
    canvas: {
      bgColor: '#000800',
      gridColor: 'rgba(0,255,65,0.08)',
      edgeColor: 'rgba(0,255,65,0.3)',
      scanline: true,
    },
    createdAt: '2024-01-01',
  },
  {
    id: 'light-clean',
    name: 'Light Clean',
    description: '밝고 깔끔한 낮 테마. 미팅/발표용.',
    author: 'Orbit',
    authorId: 'orbit',
    price: 0,
    tags: ['light', 'clean', 'minimal'],
    downloads: 0,
    rating: 4.5,
    builtin: true,
    preview: '#ffffff',
    vars: {
      '--bg': '#f6f8fa', '--bg2': '#ffffff', '--bg3': '#f0f2f4',
      '--text': '#1f2328', '--text2': '#4b5563', '--text3': '#8b949e',
      '--blue': '#0969da', '--green': '#1a7f37', '--purple': '#8250df',
      '--orange': '#953800', '--cyan': '#0a6c74', '--pink': '#bf3989',
      '--accent': '#0969da',
      '--node-glow': '0 2px 12px rgba(9,105,218,0.2)',
      '--font': "'Inter', sans-serif",
    },
    canvas: {
      bgColor: '#f6f8fa',
      gridColor: 'rgba(0,0,0,0.06)',
      edgeColor: 'rgba(9,105,218,0.3)',
    },
    createdAt: '2024-01-01',
  },
  {
    id: 'aurora',
    name: 'Aurora',
    description: '오로라 그라디언트. 보라→청록의 몽환적 분위기.',
    author: 'Orbit',
    authorId: 'orbit',
    price: 0,
    tags: ['dark', 'colorful', 'gradient'],
    downloads: 0,
    rating: 4.8,
    builtin: true,
    preview: '#06070f',
    vars: {
      '--bg': '#06070f', '--bg2': '#0c0e1a', '--bg3': '#131528',
      '--text': '#e8e8ff', '--text2': '#a0a8cc', '--text3': '#6068a0',
      '--blue': '#7eb8ff', '--green': '#4dffb8', '--purple': '#c875ff',
      '--orange': '#ff9d4d', '--cyan': '#4dffe0', '--pink': '#ff6db3',
      '--accent': '#4dffe0',
      '--node-glow': '0 0 22px rgba(77,255,224,0.4)',
      '--font': "'Inter', sans-serif",
    },
    canvas: {
      bgColor: '#06070f',
      gridColor: 'rgba(77,255,224,0.05)',
      edgeColor: 'rgba(126,184,255,0.3)',
    },
    createdAt: '2024-01-01',
  },
  {
    id: 'brutalist',
    name: 'Brutalist',
    description: '굵은 테두리, 원색, 거친 폰트. 타협 없는 UI.',
    author: 'Orbit',
    authorId: 'orbit',
    price: 0,
    tags: ['dark', 'brutalism', 'bold'],
    downloads: 0,
    rating: 4.3,
    builtin: true,
    preview: '#1a1a1a',
    vars: {
      '--bg': '#1a1a1a', '--bg2': '#222222', '--bg3': '#2a2a2a',
      '--text': '#ffffff', '--text2': '#dddddd', '--text3': '#999999',
      '--blue': '#0066ff', '--green': '#00ff00', '--purple': '#ff00ff',
      '--orange': '#ff6600', '--cyan': '#00ffff', '--pink': '#ff0066',
      '--accent': '#ffff00',
      '--node-glow': '0 0 0 3px #ffff00',
      '--font': "'Space Grotesk', 'Arial Black', sans-serif",
    },
    canvas: {
      bgColor: '#1a1a1a',
      gridColor: 'rgba(255,255,0,0.1)',
      edgeColor: 'rgba(255,255,0,0.5)',
    },
    createdAt: '2024-01-01',
  },
];

// ─── 데이터 저장소 ────────────────────────────────
function loadStore() {
  try {
    if (!fs.existsSync(THEMES_FILE)) return { userThemes: [], purchases: {}, downloads: {} };
    return JSON.parse(fs.readFileSync(THEMES_FILE, 'utf8'));
  } catch { return { userThemes: [], purchases: {}, downloads: {} }; }
}

function saveStore(data) {
  const dir = path.dirname(THEMES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(THEMES_FILE, JSON.stringify(data, null, 2));
}

// ─── API 함수 ────────────────────────────────────
function getAllThemes() {
  const store = loadStore();
  const all   = [...BUILTIN_THEMES, ...store.userThemes];
  // 다운로드 수 반영
  return all.map(t => ({ ...t, downloads: store.downloads[t.id] || t.downloads || 0 }));
}

function getThemeById(id) {
  return getAllThemes().find(t => t.id === id) || null;
}

function registerTheme(theme) {
  const store = loadStore();
  // ID 중복 방지
  if (getAllThemes().find(t => t.id === theme.id)) {
    theme.id = theme.id + '-' + Date.now().toString(36);
  }
  const entry = {
    ...theme,
    id:        theme.id || 'theme-' + Date.now().toString(36),
    authorId:  theme.authorId || 'user',
    price:     typeof theme.price === 'number' ? theme.price : 0,
    downloads: 0,
    rating:    0,
    builtin:   false,
    createdAt: new Date().toISOString().slice(0, 10),
  };
  store.userThemes.push(entry);
  saveStore(store);
  return entry;
}

function recordDownload(themeId) {
  const store = loadStore();
  store.downloads[themeId] = (store.downloads[themeId] || 0) + 1;
  saveStore(store);
}

function rateTheme(themeId, rating) {
  const store = loadStore();
  const theme = store.userThemes.find(t => t.id === themeId);
  if (theme) {
    theme.ratingCount = (theme.ratingCount || 0) + 1;
    theme.rating = ((theme.rating || 0) * (theme.ratingCount - 1) + rating) / theme.ratingCount;
    theme.rating = Math.round(theme.rating * 10) / 10;
    saveStore(store);
  }
  return getThemeById(themeId);
}

function deleteUserTheme(themeId) {
  const store = loadStore();
  store.userThemes = store.userThemes.filter(t => t.id !== themeId);
  saveStore(store);
}

module.exports = {
  getAllThemes, getThemeById, registerTheme,
  recordDownload, rateTheme, deleteUserTheme,
  BUILTIN_THEMES,
};
