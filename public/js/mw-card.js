/**
 * mw-card.js — 카드/허브 렌더링 전용 모듈
 *
 * ─ 이 파일만 보면 카드 UI 버그 해결 가능 ─
 *
 * 포함:
 *   CARD_W, CARD_H         : 카드 물리 크기 (Three.js 단위)
 *   LEVEL_CFG              : 레벨별 반지름/최대 카드 수
 *   _mwExtractColor()      : 색상 추출 유틸
 *   _mwHex2rgb()           : hex → {r,g,b}
 *   makeRingPositions()    : 원형 배치 위치 계산
 *   makeCardTexture()      : 카드 캔버스 텍스처 생성
 *   makeHubTexture()       : 허브 구체 텍스처 생성
 *
 * 의존: Three.js (전역), mw-label.js 보다 나중에 로드 불필요 (독립적)
 */

// ─── 카드 물리 크기 (Three.js 단위) ──────────────────────────────────────────
const CARD_W = 4.5;  // PlaneGeometry 가로
const CARD_H = 2.1;  // 세로 (캔버스 1024×480 비율)

// ─── 레벨별 최소 반지름·최대 카드 수 ─────────────────────────────────────────
// minR: 허브(3.2 크기) 클리어런스 최소값
// gap:  카드 간 여유 (1.0=완전 밀착)
const LEVEL_CFG = [
  { minR: 4,   maxCards: 13, gap: 1.08 },  // 0단계: 카테고리
  { minR: 4,   maxCards: 10, gap: 1.08 },  // 1단계: 이벤트
  { minR: 3.5, maxCards:  6, gap: 1.08 },  // 2단계: 세부정보
];

// ─── 색상 유틸 ────────────────────────────────────────────────────────────────
function _mwExtractColor(color, fallback) {
  const fb = fallback || '#06b6d4';
  if (!color) return fb;
  if (typeof color === 'string') return color;
  if (typeof color === 'number') return '#' + color.toString(16).padStart(6, '0');
  if (typeof color === 'object') return color.background || color.border || color.hex || fb;
  return fb;
}

function _mwHex2rgb(hex) {
  const h = (hex || '#06b6d4').replace('#', '');
  return {
    r: parseInt(h.slice(0,2),16)||6,
    g: parseInt(h.slice(2,4),16)||182,
    b: parseInt(h.slice(4,6),16)||212,
  };
}

/**
 * 동적 원형 위치 계산
 * 이웃 카드 사이 호(arc) ≥ CARD_W × gap 이 되도록 반지름 자동 결정
 */
function makeRingPositions(count, levelIdx) {
  if (count === 0) return [];
  const li  = Math.min(levelIdx || 0, LEVEL_CFG.length - 1);
  const cfg = LEVEL_CFG[li];
  const r   = Math.max(cfg.minR, (count * CARD_W * cfg.gap) / (Math.PI * 2));
  const ang = -Math.PI / 2; // 12시 방향 시작
  return Array.from({ length: count }, (_, i) => {
    const a = ang + (i / count) * Math.PI * 2;
    return { x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r };
  });
}

/**
 * 카드 텍스처 (3D 그리드 행성 스타일, 3줄 텍스트)
 * @param {string} title       상단 굵은 제목
 * @param {string} sub1        중간 (액센트 색) — 항목 수 또는 유형
 * @param {string} sub2        하단 (흐린 색) — 최근 활동
 * @param {string} accentColor hex 색상
 */
function makeCardTexture(title, sub1, sub2, accentColor) {
  const W = 1024, H = 480;  // 캔버스 해상도 (2× 스케일로 선명하게)
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);           // 2× 스케일 → 좌표공간 512×240
  const w = W / 2, h = H / 2;
  const ac  = accentColor || '#06b6d4';
  const rgb = _mwHex2rgb(ac);
  const FF  = '"Apple SD Gothic Neo","Malgun Gothic","NanumGothic",sans-serif';

  // 배경 딥우주 그라디언트
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0,   `rgba(4,10,24,0.98)`);
  bg.addColorStop(0.7, `rgba(8,18,40,0.97)`);
  bg.addColorStop(1,   `rgba(${rgb.r*0.12|0},${rgb.g*0.12|0},${rgb.b*0.12|0},0.97)`);
  const Rv = 10;
  ctx.beginPath();
  ctx.moveTo(Rv,0); ctx.lineTo(w-Rv,0);
  ctx.quadraticCurveTo(w,0,w,Rv); ctx.lineTo(w,h-Rv);
  ctx.quadraticCurveTo(w,h,w-Rv,h); ctx.lineTo(Rv,h);
  ctx.quadraticCurveTo(0,h,0,h-Rv); ctx.lineTo(0,Rv);
  ctx.quadraticCurveTo(0,0,Rv,0); ctx.closePath();
  ctx.fillStyle = bg; ctx.fill();

  // 그리드 라인
  ctx.save(); ctx.clip();
  ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.06)`;
  ctx.lineWidth = 0.5;
  for (let y = 0; y < h; y += 16) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  for (let x = 0; x < w; x += 16) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
  ctx.restore();

  // 왼쪽 액센트 바
  const bar = ctx.createLinearGradient(0,0,0,h);
  bar.addColorStop(0,   `rgba(${rgb.r},${rgb.g},${rgb.b},0.0)`);
  bar.addColorStop(0.5, `rgba(${rgb.r},${rgb.g},${rgb.b},1.0)`);
  bar.addColorStop(1,   `rgba(${rgb.r},${rgb.g},${rgb.b},0.0)`);
  ctx.fillStyle = bar; ctx.fillRect(0,0,3,h);

  // 글로우 테두리
  ctx.shadowColor = ac; ctx.shadowBlur = 8;
  ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.55)`;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(Rv,0); ctx.lineTo(w-Rv,0);
  ctx.quadraticCurveTo(w,0,w,Rv); ctx.lineTo(w,h-Rv);
  ctx.quadraticCurveTo(w,h,w-Rv,h); ctx.lineTo(Rv,h);
  ctx.quadraticCurveTo(0,h,0,h-Rv); ctx.lineTo(0,Rv);
  ctx.quadraticCurveTo(0,0,Rv,0); ctx.closePath();
  ctx.stroke(); ctx.shadowBlur = 0;

  const maxW = w - 24;
  function drawTextLine(text, y, font, color, glow) {
    if (!text) return;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    if (glow) { ctx.shadowColor = ac; ctx.shadowBlur = 4; }
    let s = String(text);
    while (ctx.measureText(s).width > maxW && s.length > 1) s = s.slice(0,-1);
    if (s !== String(text)) s += '…';
    ctx.fillText(s, 12, y);
    ctx.shadowBlur = 0;
  }

  // ── 제목 (굵고 크게, 길이 기반 동적 폰트) ──
  const titleStr = String(title || '작업');
  ctx.font = `bold 38px ${FF}`;
  const tw = ctx.measureText(titleStr).width;
  const titleFontSize = tw > maxW * 0.95 ? (tw > maxW * 1.5 ? 26 : 32) : 38;
  drawTextLine(titleStr, h * 0.28, `bold ${titleFontSize}px ${FF}`, '#e8f4ff', true);

  // ── 구분선 ──
  ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.2)`;
  ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(12, h*0.48); ctx.lineTo(w-12, h*0.48); ctx.stroke();

  // ── 서브1 (액센트 색 — 중간) ──
  drawTextLine(sub1 || '', h * 0.65, `24px ${FF}`, `rgba(${rgb.r},${rgb.g},${rgb.b},0.95)`, false);

  // ── 서브2 (흐린 색 — 하단) ──
  drawTextLine(sub2 || '', h * 0.84, `20px ${FF}`, 'rgba(148,163,184,0.85)', false);

  // 우측 상단 펄스 점
  ctx.beginPath(); ctx.arc(w-10, 10, 4, 0, Math.PI*2);
  ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.9)`;
  ctx.shadowColor = ac; ctx.shadowBlur = 6; ctx.fill(); ctx.shadowBlur = 0;

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 16;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 허브 텍스처 (행성 구체 스타일)
 */
function makeHubTexture(label) {
  const S=320, cx=S/2, cy=S/2, R=S*0.44;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');

  let glow = ctx.createRadialGradient(cx,cy,R*0.4,cx,cy,R*1.15);
  glow.addColorStop(0,'rgba(6,182,212,0.3)'); glow.addColorStop(1,'rgba(6,182,212,0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(cx,cy,R*1.15,0,Math.PI*2); ctx.fill();

  let sp = ctx.createRadialGradient(cx-R*0.28,cy-R*0.22,R*0.04,cx,cy,R);
  sp.addColorStop(0,'rgba(22,55,88,0.99)');
  sp.addColorStop(0.5,'rgba(8,26,54,0.99)');
  sp.addColorStop(1,'rgba(4,12,30,0.99)');
  ctx.fillStyle = sp;
  ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.fill();

  ctx.save(); ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.clip();
  ctx.strokeStyle='rgba(6,182,212,0.2)'; ctx.lineWidth=1;
  for (let lat=-60; lat<=60; lat+=30) {
    const ry=R*Math.cos(lat*Math.PI/180), rz=R*Math.sin(lat*Math.PI/180);
    ctx.beginPath(); ctx.ellipse(cx,cy+rz,ry,ry*0.22,0,0,Math.PI*2); ctx.stroke();
  }
  for (let lon=0; lon<180; lon+=36) {
    ctx.save(); ctx.translate(cx,cy); ctx.rotate(lon*Math.PI/180);
    ctx.beginPath(); ctx.ellipse(0,0,R*0.22,R,0,0,Math.PI*2); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  ctx.strokeStyle='#06b6d4'; ctx.lineWidth=3;
  ctx.shadowColor='#06b6d4'; ctx.shadowBlur=20;
  ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.stroke(); ctx.shadowBlur=0;

  ctx.fillStyle='#e8f4ff'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.shadowColor='#06b6d4'; ctx.shadowBlur=10;
  ctx.font='bold 32px "Apple SD Gothic Neo","Malgun Gothic","NanumGothic",sans-serif';
  let hl = String(label || '내 작업');
  if (hl.length > 10) hl = hl.slice(0, 9) + '…';
  ctx.fillText(hl, cx, cy); ctx.shadowBlur=0;

  return new THREE.CanvasTexture(canvas);
}
