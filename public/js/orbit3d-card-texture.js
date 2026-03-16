/* orbit3d-card-texture.js — Card & texture drawing helpers (extracted from render) */

// 거리 → 화면 픽셀 스케일
function screenScale(worldPos) {
  const dist = camera.position.distanceTo(worldPos);
  const fovFactor = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  return fovFactor / Math.max(dist, 0.1);
}

// pill 경로
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y); ctx.lineTo(x+w-r, y);
  ctx.arcTo(x+w, y, x+w, y+r, r); ctx.lineTo(x+w, y+h-r);
  ctx.arcTo(x+w, y+h, x+w-r, y+h, r); ctx.lineTo(x+r, y+h);
  ctx.arcTo(x, y+h, x, y+h-r, r); ctx.lineTo(x, y+r);
  ctx.arcTo(x, y, x+r, y, r); ctx.closePath();
}

// 3D 와이어프레임 그리드 헬퍼 (모든 카드/pill 공통)
function drawWireframeGrid(ctx, x, y, w, h, r, color, alpha) {
  ctx.save();
  roundRect(ctx, x, y, w, h, r); ctx.clip();
  ctx.strokeStyle = color; ctx.lineWidth = 0.5; ctx.globalAlpha = alpha;
  const midX = x + w / 2, midY = y + h / 2;
  // 수평 곡선
  const hLines = Math.max(2, Math.round(h / 14));
  for (let i = 1; i < hLines; i++) {
    const t = i / hLines;
    const gy = y + h * t;
    const bulge = Math.sin(t * Math.PI) * Math.min(3, h * 0.06);
    ctx.beginPath(); ctx.moveTo(x, gy);
    ctx.quadraticCurveTo(midX, gy - bulge, x + w, gy); ctx.stroke();
  }
  // 수직 곡선
  const vLines = Math.max(3, Math.round(w / 22));
  for (let i = 1; i < vLines; i++) {
    const t = i / vLines;
    const gx = x + w * t;
    const bulge = Math.sin(t * Math.PI) * Math.min(2, w * 0.03);
    ctx.beginPath(); ctx.moveTo(gx, y);
    ctx.quadraticCurveTo(gx + bulge, midY, gx, y + h); ctx.stroke();
  }
  ctx.restore();
}

// ── 통일 카드 상수 (모든 뷰 공통) ──────────────────────────────────────────
const UNI_CARD_W = 180, UNI_CARD_H = 51;
const UNI_CARD_R = 10, UNI_CARD_BAR = 5;
// ── 세부 세션용 소형 카드 상수 ───────────────────────────────────────────────
const SMALL_CARD_W = 140, SMALL_CARD_H = 40;
const SMALL_CARD_R = 8, SMALL_CARD_BAR = 4;

// ── 통일 카드 그리기 (모든 뷰 공통) ──────────────────────────────────────────
// 카드 내 버튼 히트 영역 등록 (편집·숨기기) — forEach 루프 내에서 호출
function drawCardIcons(ctx, cx, cy, projKey, projLabel, isHover, hitAreas) {
  if (!isHover) return;
  const lx = cx - UNI_CARD_W / 2, ly = cy - UNI_CARD_H / 2;
  // ✎ 편집: 우측 상단 내부
  const eX = lx + UNI_CARD_W - 26, eY = ly + 4;
  ctx.save();
  ctx.fillStyle = 'rgba(31,111,235,0.85)';
  roundRect(ctx, eX, eY, 20, 20, 5); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('✎', eX + 10, eY + 11);
  ctx.restore();
  if (hitAreas) hitAreas.push({ cx: eX + 10, cy: eY + 10, r: 12, data: { type: 'editNode', projKey, projLabel } });

  // 👁 숨기기: 편집 버튼 왼쪽
  const hX = eX - 24, hY = eY;
  ctx.save();
  ctx.fillStyle = 'rgba(51,65,85,0.85)';
  roundRect(ctx, hX, hY, 20, 20, 5); ctx.fill();
  ctx.fillStyle = '#94a3b8'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🙈', hX + 10, hY + 11);
  ctx.restore();
  if (hitAreas) hitAreas.push({ cx: hX + 10, cy: hY + 10, r: 12, data: { type: 'hideNode', projKey, projLabel } });
}

function drawUnifiedCard(ctx, cx, cy, color, title, sub, isActive, isHover, isDrilled) {
  const lx = cx - UNI_CARD_W / 2, ly = cy - UNI_CARD_H / 2;
  ctx.save();
  ctx.shadowColor = isDrilled ? 'rgba(6,182,212,0.25)' : 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = isDrilled ? 16 : 10; ctx.shadowOffsetY = 2;
  ctx.fillStyle = isDrilled ? 'rgba(6,182,212,0.12)' : isHover ? 'rgba(6,182,212,0.08)' : 'rgba(2,6,23,0.80)';
  roundRect(ctx, lx, ly, UNI_CARD_W, UNI_CARD_H, UNI_CARD_R); ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.restore();

  drawWireframeGrid(ctx, lx, ly, UNI_CARD_W, UNI_CARD_H, UNI_CARD_R, color, isDrilled ? 0.35 : isHover ? 0.28 : 0.18);

  // 좌측 컬러 바
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(lx + UNI_CARD_R, ly); ctx.lineTo(lx + UNI_CARD_BAR + UNI_CARD_R, ly);
  ctx.lineTo(lx + UNI_CARD_BAR + UNI_CARD_R, ly + UNI_CARD_H);
  ctx.moveTo(lx + UNI_CARD_R, ly + UNI_CARD_H);
  ctx.arcTo(lx, ly + UNI_CARD_H, lx, ly + UNI_CARD_H - UNI_CARD_R, UNI_CARD_R);
  ctx.lineTo(lx, ly + UNI_CARD_R); ctx.arcTo(lx, ly, lx + UNI_CARD_R, ly, UNI_CARD_R);
  ctx.closePath();
  ctx.fillStyle = color; ctx.globalAlpha = 0.7; ctx.fill(); ctx.globalAlpha = 1;
  ctx.restore();

  ctx.strokeStyle = isDrilled ? color : isHover ? 'rgba(6,182,212,0.4)' : 'rgba(255,255,255,0.10)';
  ctx.lineWidth = isDrilled ? 1.5 : isHover ? 1.2 : 0.8;
  roundRect(ctx, lx, ly, UNI_CARD_W, UNI_CARD_H, UNI_CARD_R); ctx.stroke();

  if (isActive) {
    ctx.save();
    ctx.fillStyle = '#22c55e'; ctx.shadowColor = '#22c55e'; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.arc(lx + UNI_CARD_W - 8, ly + 8, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  const textX = lx + UNI_CARD_BAR + UNI_CARD_R + 6;
  const maxTextW = UNI_CARD_W - UNI_CARD_BAR - UNI_CARD_R - 16;
  ctx.textAlign = 'left';
  ctx.font = "600 14px 'Inter',-apple-system,sans-serif";
  ctx.fillStyle = '#e2e8f0';
  let clipped = title;
  while (ctx.measureText(clipped).width > maxTextW && clipped.length > 1) clipped = clipped.slice(0, -1);
  if (clipped !== title) clipped += '\u2026';
  ctx.fillText(clipped, textX, ly + 21);

  if (sub) {
    ctx.font = "400 11px 'JetBrains Mono','Fira Code',monospace";
    ctx.fillStyle = '#94a3b8';
    let cs = sub;
    while (ctx.measureText(cs).width > maxTextW && cs.length > 1) cs = cs.slice(0, -1);
    if (cs !== sub) cs += '\u2026';
    ctx.fillText(cs, textX, ly + 39);
  }
}

// ── 소형 카드 (세부 세션용 — 프로젝트 카드보다 작게) ─────────────────────────
function drawSmallCard(ctx, cx, cy, color, title, sub, isHover) {
  const lx = cx - SMALL_CARD_W / 2, ly = cy - SMALL_CARD_H / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 6; ctx.shadowOffsetY = 1;
  ctx.fillStyle = isHover ? 'rgba(6,182,212,0.08)' : 'rgba(2,6,23,0.75)';
  roundRect(ctx, lx, ly, SMALL_CARD_W, SMALL_CARD_H, SMALL_CARD_R); ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.restore();

  drawWireframeGrid(ctx, lx, ly, SMALL_CARD_W, SMALL_CARD_H, SMALL_CARD_R, color, isHover ? 0.22 : 0.12);

  // 좌측 컬러 바
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(lx + SMALL_CARD_R, ly); ctx.lineTo(lx + SMALL_CARD_BAR + SMALL_CARD_R, ly);
  ctx.lineTo(lx + SMALL_CARD_BAR + SMALL_CARD_R, ly + SMALL_CARD_H);
  ctx.moveTo(lx + SMALL_CARD_R, ly + SMALL_CARD_H);
  ctx.arcTo(lx, ly + SMALL_CARD_H, lx, ly + SMALL_CARD_H - SMALL_CARD_R, SMALL_CARD_R);
  ctx.lineTo(lx, ly + SMALL_CARD_R); ctx.arcTo(lx, ly, lx + SMALL_CARD_R, ly, SMALL_CARD_R);
  ctx.closePath();
  ctx.fillStyle = color; ctx.globalAlpha = 0.6; ctx.fill(); ctx.globalAlpha = 1;
  ctx.restore();

  ctx.strokeStyle = isHover ? 'rgba(6,182,212,0.4)' : 'rgba(255,255,255,0.08)';
  ctx.lineWidth = isHover ? 1 : 0.6;
  roundRect(ctx, lx, ly, SMALL_CARD_W, SMALL_CARD_H, SMALL_CARD_R); ctx.stroke();

  const textX = lx + SMALL_CARD_BAR + SMALL_CARD_R + 5;
  const maxTextW = SMALL_CARD_W - SMALL_CARD_BAR - SMALL_CARD_R - 12;
  ctx.textAlign = 'left';
  ctx.font = "500 12px 'Inter',-apple-system,sans-serif";
  ctx.fillStyle = '#cbd5e1';
  let clipped = title;
  while (ctx.measureText(clipped).width > maxTextW && clipped.length > 1) clipped = clipped.slice(0, -1);
  if (clipped !== title) clipped += '\u2026';
  ctx.fillText(clipped, textX, ly + 17);

  if (sub) {
    ctx.font = "400 10px 'JetBrains Mono','Fira Code',monospace";
    ctx.fillStyle = '#64748b';
    let cs = sub;
    while (ctx.measureText(cs).width > maxTextW && cs.length > 1) cs = cs.slice(0, -1);
    if (cs !== sub) cs += '\u2026';
    ctx.fillText(cs, textX, ly + 31);
  }
}

// 3D → 화면 좌표
function toScreen(worldPos) {
  const v = worldPos.clone().project(camera);
  return { x:(v.x+1)/2*innerWidth, y:(-v.y+1)/2*innerHeight, z:v.z };
}

// ─── 글로우 pill 헬퍼 ────────────────────────────────────────────────────────
function drawGlow(ctx, cx, cy, r, hex, intensity) {
  if (intensity <= 0.02) return;
  const grad = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 2.8);
  const alpha = (intensity * 0.55).toFixed(3);
  grad.addColorStop(0, hex + Math.round(intensity * 200).toString(16).padStart(2,'0'));
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 2.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ─── 3D 와이어프레임 구체 (세션/프로젝트 노드) ──────────────────────────────
function _drawWireSphere(ctx, cx, cy, R, color, opts) {
  const { alpha, lineW, meridians, parallels, glow, hover, drilled, rotation } = Object.assign(
    { alpha: 0.35, lineW: 0.8, meridians: 3, parallels: 2, glow: true, hover: false, drilled: false, rotation: 0 },
    opts || {}
  );
  ctx.save();

  // 글로우 (외부 빛)
  if (glow) {
    const g = ctx.createRadialGradient(cx, cy, R * 0.5, cx, cy, R * 1.6);
    g.addColorStop(0, color + (drilled ? '30' : '18'));
    g.addColorStop(1, color + '00');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.6, 0, Math.PI * 2); ctx.fill();
  }

  // 미세 투명 채움 (유리 느낌)
  ctx.globalAlpha = drilled ? 0.18 : hover ? 0.12 : 0.05;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

  // 적도 (외곽 원)
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = drilled ? lineW * 2 : hover ? lineW * 1.8 : lineW;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();

  // 경선 (세로 타원 — 회전 적용)
  for (let m = 0; m < meridians; m++) {
    const angle = (m / meridians) * Math.PI + rotation;
    const scaleX = Math.abs(Math.cos(angle));
    ctx.globalAlpha = alpha * 0.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, R * Math.max(scaleX, 0.08), R, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 위선 (가로 타원)
  for (let p = 1; p <= parallels; p++) {
    const lat = p / (parallels + 1);
    const y = cy + R * (lat * 2 - 1) * 0.7;
    const rX = R * Math.cos(Math.asin(lat * 2 - 1) * 0.7);
    if (rX > 2) {
      ctx.globalAlpha = alpha * 0.35;
      ctx.beginPath();
      ctx.ellipse(cx, y, rX, rX * 0.25, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 드릴다운 선택 시 외곽 펄스
  if (drilled) {
    ctx.globalAlpha = 0.4 + 0.2 * Math.sin(performance.now() / 300);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, R + 4, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.restore();
}

// 와이어프레임 구체 내부 텍스트 라벨 (PURPOSE + WHAT + RESULT — 3단계 심층 요약)
// extraCtx (optional 11th param): { purpose, techStack, duration, appsUsed, aiTools }
function _drawSphereLabel(ctx, cx, cy, R, title, sub, color, dimmed, whatLine, resultLine, extraCtx) {
  ctx.save();
  if (dimmed) ctx.globalAlpha = 0.3;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const fontSize = Math.max(7, Math.min(12, R * 0.45));
  const maxW = R * 1.5; // 구체 지름의 75% (텍스트가 밖으로 안 나감)
  const ex = extraCtx || {};

  // 구체 높이 내 맞출 수 있는 줄 수 계산
  const lineSpacing = fontSize * 1.35; // 줄 간격 = 폰트 크기의 135% (겹침 방지)
  const maxFitLines = Math.max(1, Math.floor((R * 1.4) / lineSpacing));
  const maxLines = Math.min(maxFitLines, 3);

  const displayTitle = title;
  const displaySub = maxLines >= 2 ? (sub || '') : '';
  const hasWhat = maxLines >= 3 && whatLine && whatLine.length > 0;
  const hasResult = !hasWhat && maxLines >= 3 && resultLine && resultLine.length > 0;

  let totalLines = 1;
  if (displaySub) totalLines++;
  if (hasWhat) totalLines++;
  if (hasResult) totalLines++;
  const blockHeight = totalLines * lineSpacing;
  let curY = cy - blockHeight / 2 + lineSpacing / 2;

  // ── Line 1: 제목 (purpose 또는 기존 title) — 길면 2줄 분할 ──
  ctx.font = `600 ${fontSize}px 'Inter',-apple-system,sans-serif`;
  ctx.fillStyle = '#e2e8f0';

  if (ctx.measureText(displayTitle).width <= maxW) {
    ctx.fillText(displayTitle, cx, curY);
    curY += lineSpacing;
  } else {
    // 두 줄로 분할
    const mid = Math.floor(displayTitle.length / 2);
    let splitIdx = -1;
    for (let d = 0; d <= mid; d++) {
      if (displayTitle[mid + d] === ' ') { splitIdx = mid + d; break; }
      if (mid - d >= 0 && displayTitle[mid - d] === ' ') { splitIdx = mid - d; break; }
    }
    let line1, line2;
    if (splitIdx > 0) {
      line1 = displayTitle.slice(0, splitIdx);
      line2 = displayTitle.slice(splitIdx + 1);
    } else {
      line1 = displayTitle.slice(0, mid);
      line2 = displayTitle.slice(mid);
    }
    if (ctx.measureText(line1).width > maxW) {
      while (ctx.measureText(line1).width > maxW && line1.length > 1) line1 = line1.slice(0, -1);
      line1 += '\u2026';
    }
    if (ctx.measureText(line2).width > maxW) {
      while (ctx.measureText(line2).width > maxW && line2.length > 1) line2 = line2.slice(0, -1);
      line2 += '\u2026';
    }
    const halfGap = fontSize * 0.55;
    ctx.fillText(line1, cx, curY - halfGap);
    ctx.fillText(line2, cx, curY + halfGap);
    curY += lineSpacing;
  }

  // ── Line 1.5: 부제 (프로젝트명 등) ──
  if (displaySub) {
    const subSize = Math.max(7, fontSize - 2);
    ctx.font = `400 ${subSize}px 'JetBrains Mono','Fira Code',monospace`;
    ctx.fillStyle = '#94a3b8';
    let cs = displaySub.length > 24 ? displaySub.slice(0, 23) + '\u2026' : displaySub;
    ctx.fillText(cs, cx, curY);
    curY += lineSpacing * 0.85;
  }

  // ── Line 2: WHAT — 모듈 단위 행동 (하늘색) ──
  if (hasWhat) {
    const whatSize = Math.max(6, fontSize - 2);
    ctx.font = `400 ${whatSize}px 'JetBrains Mono','Fira Code',monospace`;
    ctx.fillStyle = '#7dd3fc';
    let cw = whatLine.length > 26 ? whatLine.slice(0, 25) + '\u2026' : whatLine;
    ctx.fillText(cw, cx, curY);
    curY += lineSpacing * 0.85;
  }

  // ── Line 3: RESULT — 결과 요약 (초록색) ──
  if (hasResult) {
    const resSize = Math.max(6, fontSize - 2);
    ctx.font = `400 ${resSize}px 'JetBrains Mono','Fira Code',monospace`;
    ctx.fillStyle = '#86efac';
    let cr = resultLine.length > 26 ? resultLine.slice(0, 25) + '\u2026' : resultLine;
    ctx.fillText(cr, cx, curY);
    curY += lineSpacing * 0.85;
  }

  // Line 4 제거됨 (3줄 제한으로 충분)

  ctx.restore();
}

// 3번째 줄 텍스트 조합 (techStack + duration + aiTools)
function _buildLine3(ex) {
  const parts = [];
  if (ex.techStack) parts.push(ex.techStack);
  if (ex.duration) parts.push(ex.duration);
  if (ex.aiTools && parts.length < 2) parts.push(ex.aiTools);
  return parts.join(' \u00B7 '); // middle dot separator
}
