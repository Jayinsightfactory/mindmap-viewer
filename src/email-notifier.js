'use strict';
/**
 * email-notifier.js
 * Orbit AI 업데이트 결과 이메일 알림 (Naver SMTP)
 *
 * 환경변수:
 *   NOTIFY_EMAIL_USER  — 발신 네이버 계정 (기본: dlaww@naver.com)
 *   NOTIFY_EMAIL_PASS  — 네이버 SMTP 비밀번호 (필수)
 *   NOTIFY_EMAIL_TO    — 수신 이메일 (기본: dlaww@naver.com)
 */

let nodemailer;
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }

const FROM  = process.env.NOTIFY_EMAIL_USER || 'dlaww@naver.com';
const TO    = process.env.NOTIFY_EMAIL_TO   || 'dlaww@naver.com';
const PASS  = process.env.NOTIFY_EMAIL_PASS || '';

// 마지막 발송 시각 추적 (동일 호스트 5분 내 중복 발송 방지)
const _lastSent = {};  // { hostname: timestamp }
const COOLDOWN_MS = 5 * 60 * 1000;

function createTransporter() {
  if (!nodemailer || !PASS) return null;
  return nodemailer.createTransport({
    host: 'smtp.naver.com',
    port: 465,
    secure: true,
    auth: { user: FROM, pass: PASS },
    connectionTimeout: 10000,
    socketTimeout: 10000,
  });
}

/**
 * daemon.update 이벤트를 받아 이메일 발송
 * @param {object} ev — Orbit 이벤트 ({ type, data: { status, hostname, ... } })
 */
async function sendUpdateEmail(ev) {
  const data = ev.data || {};
  const status   = data.status || '';
  const hostname = data.hostname || data.pcId || '알 수 없음';
  const version  = data.version || data.tag || '';
  const detail   = data.detail || data.error || '';
  const ts       = ev.timestamp ? new Date(ev.timestamp).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  // 성공/실패만 발송 (update_start, update_skip 제외)
  if (status !== 'update_success' && status !== 'update_fail') return;

  // 중복 발송 방지
  const key = `${hostname}-${status}`;
  if (_lastSent[key] && Date.now() - _lastSent[key] < COOLDOWN_MS) return;
  _lastSent[key] = Date.now();

  if (!PASS) {
    console.warn('[email-notifier] NOTIFY_EMAIL_PASS 미설정 — 이메일 발송 건너뜀');
    return;
  }

  const isSuccess = status === 'update_success';
  const emoji     = isSuccess ? '✅' : '❌';
  const subject   = `${emoji} Orbit AI 업데이트 ${isSuccess ? '완료' : '실패'} — ${hostname}`;

  const html = `
<div style="font-family:Apple SD Gothic Neo,Malgun Gothic,sans-serif;max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
  <div style="background:${isSuccess ? '#1e6cd2' : '#dc2626'};padding:20px 24px;">
    <h1 style="color:#fff;margin:0;font-size:18px;">${emoji} Orbit AI 업데이트 ${isSuccess ? '완료' : '실패'}</h1>
  </div>
  <div style="padding:24px;">
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 0;color:#6b7280;width:90px;">PC</td><td style="padding:6px 0;font-weight:600;">${hostname}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">결과</td><td style="padding:6px 0;font-weight:600;color:${isSuccess ? '#16a34a' : '#dc2626'};">${isSuccess ? '업데이트 성공' : '업데이트 실패'}</td></tr>
      ${version ? `<tr><td style="padding:6px 0;color:#6b7280;">버전</td><td style="padding:6px 0;">${version}</td></tr>` : ''}
      <tr><td style="padding:6px 0;color:#6b7280;">시간</td><td style="padding:6px 0;">${ts}</td></tr>
      ${detail && !isSuccess ? `<tr><td style="padding:6px 0;color:#6b7280;vertical-align:top;">오류</td><td style="padding:6px 0;color:#dc2626;font-size:12px;word-break:break-all;">${detail}</td></tr>` : ''}
    </table>
    ${!isSuccess ? '<p style="margin-top:16px;padding:12px;background:#fef2f2;border-radius:6px;font-size:13px;color:#7f1d1d;">PC를 확인하거나 수동으로 <code>git pull</code> 후 재시작하세요.</p>' : ''}
  </div>
  <div style="padding:12px 24px;background:#f9fafb;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb;">
    Orbit AI 자동 알림 · 수신 거부: 관리자에게 문의
  </div>
</div>`.trim();

  try {
    const transporter = createTransporter();
    if (!transporter) return;
    await transporter.sendMail({ from: `"Orbit AI" <${FROM}>`, to: TO, subject, html });
    console.log(`[email-notifier] 발송 완료 → ${TO} (${hostname} / ${status})`);
  } catch (err) {
    console.error(`[email-notifier] 발송 실패: ${err.message}`);
  }
}

module.exports = { sendUpdateEmail };
