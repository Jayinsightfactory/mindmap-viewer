'use strict';
/**
 * routes/webhooks.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 외부 도구 웹훅 수신 API
 *
 * POST /api/webhooks/n8n       — n8n 워크플로우 웹훅
 * POST /api/webhooks/slack     — Slack Events API / 슬래시 커맨드
 * POST /api/webhooks/notion    — Notion 데이터베이스 변경 알림
 * POST /api/webhooks/github    — GitHub 웹훅 (이슈, PR, 푸시)
 * POST /api/webhooks/generic   — 범용 웹훅 (사용자 정의)
 * GET  /api/webhooks/history   — 수신 웹훅 기록 조회
 * GET  /api/webhooks/config    — 웹훅 설정 정보 (등록 URL 표시)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const crypto  = require('crypto');

// 인메모리 웹훅 수신 기록 (최대 200개)
const webhookHistory = [];
const MAX_HISTORY = 200;

function recordWebhook(platform, event, data) {
  const entry = {
    id:         `wh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    platform,
    event,
    receivedAt: new Date().toISOString(),
    summary:    data?.summary || '',
    raw:        data,
  };
  webhookHistory.unshift(entry);
  if (webhookHistory.length > MAX_HISTORY) webhookHistory.splice(MAX_HISTORY);
  return entry;
}

/**
 * GitHub 웹훅 서명 검증 (GITHUB_WEBHOOK_SECRET 환경변수 필요)
 */
function verifyGithubSignature(req) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return true; // 시크릿 없으면 스킵 (개발 환경)

  const sig = req.headers['x-hub-signature-256'] || '';
  if (!sig) return false;

  const payload = JSON.stringify(req.body);
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

function createWebhooksRouter({ insertEvent, broadcastAll }) {
  const router = express.Router();

  // ── n8n 웹훅 수신 ───────────────────────────────────────────────────────
  router.post('/webhooks/n8n', (req, res) => {
    try {
      const body  = req.body || {};
      const event = body.event || body.type || 'n8n.workflow';
      const wfName = body.workflow?.name || body.workflowName || 'Unknown Workflow';

      // Orbit 이벤트로 변환하여 삽입
      const orbitEvent = normalizeToOrbitEvent({
        type:   `n8n.${event.replace(/\./g, '_')}`,
        source: 'n8n',
        data: {
          workflow: wfName,
          status:   body.status || body.executionStatus || 'completed',
          node:     body.lastNode || '',
          runData:  body.runData || null,
          summary:  `n8n 워크플로우: ${wfName} — ${event}`,
        },
      });

      if (insertEvent) insertEvent(orbitEvent);
      const entry = recordWebhook('n8n', event, { summary: `워크플로우: ${wfName}`, workflow: wfName });
      if (broadcastAll) broadcastAll({ type: 'webhook', platform: 'n8n', event, summary: entry.summary });

      res.json({ ok: true, id: entry.id, event: orbitEvent.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Slack Events API ─────────────────────────────────────────────────────
  router.post('/webhooks/slack', (req, res) => {
    try {
      const body = req.body || {};

      // Slack URL 검증 챌린지
      if (body.type === 'url_verification') {
        return res.json({ challenge: body.challenge });
      }

      const slackEvent = body.event || {};
      const eventType  = slackEvent.type || body.type || 'unknown';
      const channel    = slackEvent.channel || body.channel_id || '';
      const user       = slackEvent.user || body.user_id || '';
      const text       = (slackEvent.text || body.text || '').slice(0, 200);

      const orbitEvent = normalizeToOrbitEvent({
        type:   `slack.${eventType}`,
        source: 'slack',
        data: {
          channel, user, text,
          teamId:  body.team_id || '',
          summary: `Slack ${eventType}: ${text.slice(0, 80) || `채널 ${channel}`}`,
        },
      });

      if (insertEvent) insertEvent(orbitEvent);
      const entry = recordWebhook('slack', eventType, { summary: `[${channel}] ${text.slice(0, 50)}` });
      if (broadcastAll) broadcastAll({ type: 'webhook', platform: 'slack', event: eventType, summary: entry.summary });

      res.json({ ok: true, id: entry.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Slack 슬래시 커맨드 (/orbit 등) ─────────────────────────────────────
  router.post('/webhooks/slack/command', (req, res) => {
    try {
      const body    = req.body || {};
      const command = body.command || '/orbit';
      const text    = (body.text || '').trim();
      const user    = body.user_name || '';
      const channel = body.channel_name || '';

      // 슬래시 커맨드 처리
      let responseText = `✅ Orbit 명령 수신: \`${command} ${text}\``;

      if (text === 'status') {
        responseText = `⬡ *Orbit AI* 서버 정상 동작 중\n채널: ${channel} | 사용자: ${user}`;
      } else if (text.startsWith('note')) {
        const note = text.slice(4).trim();
        const orbitEvent = normalizeToOrbitEvent({
          type:   'slack.note',
          source: 'slack',
          data:   { note, user, channel, summary: `Slack 메모: ${note}` },
        });
        if (insertEvent) insertEvent(orbitEvent);
        responseText = `📝 메모 저장됨: ${note}`;
      }

      recordWebhook('slack', 'slash_command', { summary: `${command} ${text}` });
      if (broadcastAll) broadcastAll({ type: 'webhook', platform: 'slack', event: 'slash_command' });

      // Slack 슬래시 커맨드는 즉시 응답 필요
      res.json({ response_type: 'in_channel', text: responseText });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Notion 웹훅 ──────────────────────────────────────────────────────────
  // (Notion은 공식 웹훅이 없어서 n8n/Zapier를 통해 중계하는 패턴)
  router.post('/webhooks/notion', (req, res) => {
    try {
      const body    = req.body || {};
      const pageId  = body.pageId || body.page?.id || '';
      const dbId    = body.databaseId || body.database?.id || '';
      const action  = body.action || 'updated';
      const title   = body.title || body.page?.properties?.title?.title?.[0]?.plain_text || 'Notion 페이지';

      const orbitEvent = normalizeToOrbitEvent({
        type:   `notion.${action}`,
        source: 'notion',
        data: {
          pageId, dbId, action, title,
          url:     body.url || `https://notion.so/${pageId.replace(/-/g, '')}`,
          summary: `Notion ${action}: ${title}`,
        },
      });

      if (insertEvent) insertEvent(orbitEvent);
      const entry = recordWebhook('notion', action, { summary: `${title} — ${action}` });
      if (broadcastAll) broadcastAll({ type: 'webhook', platform: 'notion', event: action, summary: entry.summary });

      res.json({ ok: true, id: entry.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GitHub 웹훅 ──────────────────────────────────────────────────────────
  router.post('/webhooks/github', (req, res) => {
    try {
      if (!verifyGithubSignature(req)) {
        return res.status(401).json({ error: '서명 검증 실패' });
      }

      const event = req.headers['x-github-event'] || 'unknown';
      const body  = req.body || {};
      const repo  = body.repository?.full_name || '';
      const actor = body.sender?.login || body.pusher?.name || '';

      let summary = `GitHub ${event}: ${repo}`;
      let data    = { event, repo, actor };

      if (event === 'push') {
        const commits = body.commits || [];
        const branch  = (body.ref || '').replace('refs/heads/', '');
        data = { ...data, branch, commitCount: commits.length,
                 lastMessage: commits[0]?.message?.slice(0, 100) || '' };
        summary = `GitHub Push → ${repo}/${branch} (${commits.length}개 커밋)`;
      } else if (event === 'pull_request') {
        const pr     = body.pull_request || {};
        const action = body.action || '';
        data = { ...data, action, prNumber: pr.number, prTitle: pr.title?.slice(0, 100) || '', prState: pr.state };
        summary = `GitHub PR #${pr.number} ${action}: ${pr.title?.slice(0, 60) || ''}`;
      } else if (event === 'issues') {
        const issue  = body.issue || {};
        const action = body.action || '';
        data = { ...data, action, issueNumber: issue.number, issueTitle: issue.title?.slice(0, 100) || '' };
        summary = `GitHub Issue #${issue.number} ${action}: ${issue.title?.slice(0, 60) || ''}`;
      } else if (event === 'release') {
        const release = body.release || {};
        data = { ...data, tagName: release.tag_name, releaseName: release.name?.slice(0, 100) || '' };
        summary = `GitHub Release: ${release.tag_name} — ${release.name?.slice(0, 50) || ''}`;
      }

      const orbitEvent = normalizeToOrbitEvent({
        type:   `github.${event}`,
        source: 'github-webhook',
        data:   { ...data, summary },
      });

      if (insertEvent) insertEvent(orbitEvent);
      const entry = recordWebhook('github', event, { summary });
      if (broadcastAll) broadcastAll({ type: 'webhook', platform: 'github', event, summary: entry.summary });

      res.json({ ok: true, id: entry.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 범용 웹훅 (사용자 정의) ─────────────────────────────────────────────
  router.post('/webhooks/generic', (req, res) => {
    try {
      const body    = req.body || {};
      const source  = (req.query.source || body.source || 'generic').slice(0, 30);
      const event   = (req.query.event  || body.type   || 'event').slice(0, 50);
      const summary = (body.summary || body.message || body.text || `${source} ${event}`).slice(0, 200);

      const orbitEvent = normalizeToOrbitEvent({
        type:   `${source}.${event}`,
        source: source,
        data:   { ...body, summary },
      });

      if (insertEvent) insertEvent(orbitEvent);
      const entry = recordWebhook(source, event, { summary });
      if (broadcastAll) broadcastAll({ type: 'webhook', platform: source, event, summary: entry.summary });

      res.json({ ok: true, id: entry.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 웹훅 수신 기록 조회 ──────────────────────────────────────────────────
  router.get('/webhooks/history', (req, res) => {
    const limit    = Math.min(parseInt(req.query.limit) || 50, 200);
    const platform = req.query.platform || '';
    const filtered = platform
      ? webhookHistory.filter(w => w.platform === platform)
      : webhookHistory;
    res.json({
      history: filtered.slice(0, limit),
      total:   filtered.length,
    });
  });

  // ── 웹훅 설정 정보 (등록 URL 안내) ─────────────────────────────────────
  router.get('/webhooks/config', (req, res) => {
    const base = process.env.OAUTH_CALLBACK_BASE || `http://localhost:${process.env.PORT || 4747}`;
    res.json({
      endpoints: {
        n8n:     { url: `${base}/api/webhooks/n8n`,           method: 'POST', description: 'n8n 워크플로우 트리거' },
        slack:   { url: `${base}/api/webhooks/slack`,         method: 'POST', description: 'Slack Events API' },
        slashCmd:{ url: `${base}/api/webhooks/slack/command`, method: 'POST', description: 'Slack 슬래시 커맨드' },
        notion:  { url: `${base}/api/webhooks/notion`,        method: 'POST', description: 'Notion 변경 알림 (n8n 중계)' },
        github:  { url: `${base}/api/webhooks/github`,        method: 'POST', description: 'GitHub 웹훅', headers: { 'x-github-event': '자동 설정됨' } },
        generic: { url: `${base}/api/webhooks/generic?source=myapp&event=deploy`, method: 'POST', description: '범용 웹훅' },
      },
      securityNote: 'GITHUB_WEBHOOK_SECRET 환경변수로 GitHub 서명 검증 활성화',
      historyUrl:   `${base}/api/webhooks/history`,
    });
  });

  return router;
}

// ── 웹훅 데이터 → Orbit 이벤트 정규화 ──────────────────────────────────────
const { ulid } = (() => { try { return require('ulid'); } catch { return { ulid: () => Date.now().toString(36) + Math.random().toString(36).slice(2) }; } })();

function normalizeToOrbitEvent({ type, source, data }) {
  return {
    id:        ulid(),
    type:      type || 'webhook.event',
    source:    source || 'webhook',
    sessionId: `webhook_${source}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
    userId:    'webhook',
    channelId: 'default',
    timestamp: new Date().toISOString(),
    data:      typeof data === 'string' ? data : JSON.stringify(data),
    metadata:  JSON.stringify({ via: 'webhook', platform: source }),
  };
}

module.exports = createWebhooksRouter;
