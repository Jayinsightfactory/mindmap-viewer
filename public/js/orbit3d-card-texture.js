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
