'use strict';
/**
 * exec-gate.js — 골 파이프라인 실행 게이트 (Jev식 판단: 실행 전 두 가지만 묻는다)
 *   ① 되돌릴 수 없는 행동인가?  (삭제·전송·결제·송금·확정·DB 변경·메일 발송…)  → 예면 사람 확인(job.confirmIrreversible=true) 없이는 실행 금지
 *   ② 예상한 화면인가?          (job.expectWindow 가 있으면 현재 활성 창 제목과 대조) → 아니면 실행 금지
 *   답은 judge 계층(규칙+확신도, 결정 로그 ~/.orbit/judge-log.jsonl)으로. 확신이 낮으면 항상 '위험' 쪽(보수적).
 *   LangChain AutoModeMiddleware(Jev로 도구 호출을 실행 전 심사)와 같은 자리. 설계: "Jev식 판단 계층 로컬 적용 설계" 2026-09-26.
 */
const judge = require('./judge');

// 되돌릴 수 없는 행동 신호(스크립트 본문·actionType·설명에서). 확신도는 패턴 강도.
const IRREVERSIBLE = [
  [/\b(rm|del|erase|Remove-Item|rmdir|DROP\s+TABLE|TRUNCATE|DELETE\s+FROM|UPDATE\s+\w+\s+SET|INSERT\s+INTO)\b/i, 0.95, 'delete/db-write'],
  [/(송금|이체|결제|승인|확정|발행|전송|발송|Send-MailMessage|smtp|\.Send\(|sendkeys.*\{ENTER\}.*(저장|확정|전송))/i, 0.9, 'money/send/confirm'],
  [/(저장|save|submit|commit|apply|등록)\b/i, 0.7, 'save/submit'],
  [/(format|diskpart|shutdown|restart-computer|reg\s+delete|Set-ItemProperty.*HKLM)/i, 0.98, 'system-destructive'],
];
const READ_ONLY = /^(get-|select\s|dir\b|ls\b|type\b|cat\b|echo\b|read|screenshot|capture|copy-item.*-whatif)/im;

function ruleIrreversible(text) {
  for (const [re, conf, reason] of IRREVERSIBLE) if (re.test(text)) return { answer: 'yes', confidence: conf, reason };
  if (READ_ONLY.test(text)) return { answer: 'no', confidence: 0.85, reason: 'read-only' };
  return { answer: 'no', confidence: 0.55, reason: 'no-signal' }; // 신호 없음 = 확신 낮음 → 아래에서 보수적으로 처리
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * check(job, { activeWindowTitle }) → { allow, reasons[], irreversible:{answer,confidence,by}, window:{expected, actual, match} }
 */
async function check(job = {}, ctx = {}) {
  const text = [job.actionType, job.description, job.script].filter(Boolean).join('\n');
  const irr = await judge.bool({ key: 'exec-irreversible', text, rule: ruleIrreversible, thresholds: { rule: 0.8, local: 0.85 } });
  const reasons = [];
  // 확신 낮은 '아니오'(신호 없음)는 되돌릴 수 없는 쪽으로 간주 — 애매하면 사람 확인
  const risky = irr.yes || irr.confidence < 0.7;
  if (risky && job.confirmIrreversible !== true) reasons.push(`되돌릴 수 없는 행동 가능성(${irr.reason || irr.by}, 확신 ${irr.confidence}) — confirmIrreversible=true 필요`);
  let window = null;
  if (job.expectWindow) {
    const actual = String(ctx.activeWindowTitle || '');
    const match = !!actual && norm(actual).includes(norm(job.expectWindow));
    window = { expected: job.expectWindow, actual, match };
    if (!match) reasons.push(`예상 화면 아님: 기대 "${job.expectWindow}" / 현재 "${actual || '(없음)'}"`);
  }
  return { allow: reasons.length === 0, reasons, irreversible: { answer: irr.answer, confidence: irr.confidence, by: irr.by, reason: irr.reason }, window };
}

module.exports = { check, ruleIrreversible };
