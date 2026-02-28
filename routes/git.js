/**
 * routes/git.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Git 이벤트 통합 — 로컬 Git hooks + GitHub/GitLab Webhook 수신
 *
 * 엔드포인트:
 *   POST /api/git/hook      — 로컬 git hook (post-commit, post-push 등)
 *   POST /api/git/webhook   — GitHub/GitLab 웹훅 (X-GitHub-Event 헤더)
 *   GET  /api/git/summary   — 최근 커밋 요약
 *   GET  /api/git/install   — 자동 설치 스크립트 다운로드 (bash)
 *
 * 설치 방법 (프로젝트 루트에서):
 *   curl http://localhost:4747/api/git/install | bash
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express  = require('express');
const crypto   = require('crypto');

/**
 * @param {{ insertEvent, broadcastAll }} deps
 * @returns {express.Router}
 */
function createRouter({ insertEvent, broadcastAll }) {
  const router = express.Router();

  // ─── 로컬 Git Hook 수신 ─────────────────────────────────────────────────────
  // post-commit, post-push, post-merge-commit 등이 이쪽으로 전송
  //
  // Body: { type, summary, metadata: { hash, files, branch, author } }
  router.post('/git/hook', (req, res) => {
    const { type = 'git.commit', summary, metadata = {}, channelId = 'git' } = req.body;

    if (!summary && !metadata.hash) {
      return res.status(400).json({ error: 'summary or metadata.hash required' });
    }

    const event = {
      id:        `git_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      type:      `git.${type.replace(/^git\./, '')}`,
      source:    'git-hook',
      sessionId: metadata.branch || 'git-default',
      channelId,
      timestamp: new Date().toISOString(),
      data: {
        summary: summary || metadata.hash?.slice(0, 8),
        hash:    metadata.hash,
        files:   typeof metadata.files === 'string'
          ? metadata.files.split(',').filter(Boolean)
          : (metadata.files || []),
        branch:  metadata.branch || 'main',
        author:  metadata.author || 'unknown',
        remote:  metadata.remote || null,
      },
      metadata: { source: 'git', ...metadata },
    };

    try {
      insertEvent(event);
      broadcastAll({ type: 'new_event', event });
      res.json({ ok: true, id: event.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GitHub/GitLab Webhook 수신 ─────────────────────────────────────────────
  // GitHub: X-GitHub-Event 헤더
  // GitLab: X-Gitlab-Event 헤더
  router.post('/git/webhook', (req, res) => {
    const ghEvent = req.headers['x-github-event'];
    const glEvent = req.headers['x-gitlab-event'];
    const eventType = ghEvent || glEvent;

    if (!eventType) {
      return res.status(400).json({ error: 'Missing X-GitHub-Event or X-Gitlab-Event header' });
    }

    // GitHub Webhook 서명 검증 (GITHUB_WEBHOOK_SECRET 설정 시)
    if (process.env.GITHUB_WEBHOOK_SECRET) {
      const sig  = req.headers['x-hub-signature-256'];
      const body = JSON.stringify(req.body);
      const expected = 'sha256=' + crypto
        .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET)
        .update(body)
        .digest('hex');
      if (!sig || sig !== expected) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    }

    const payload = req.body;
    let orbitEvent = null;

    if (ghEvent === 'push') {
      const commits = payload.commits || [];
      commits.forEach(commit => {
        orbitEvent = {
          id:        `gh_push_${commit.id?.slice(0, 8) || Date.now()}`,
          type:      'git.commit',
          source:    'github-webhook',
          sessionId: payload.repository?.name || 'github',
          channelId: 'github',
          timestamp: commit.timestamp || new Date().toISOString(),
          data: {
            summary: commit.message?.split('\n')[0],
            hash:    commit.id,
            files:   [...(commit.added || []), ...(commit.modified || []), ...(commit.removed || [])],
            branch:  payload.ref?.replace('refs/heads/', ''),
            author:  commit.author?.name || 'unknown',
          },
          metadata: { source: 'github', repo: payload.repository?.full_name },
        };
        try { insertEvent(orbitEvent); } catch {}
      });
    } else if (ghEvent === 'pull_request') {
      const pr = payload.pull_request;
      orbitEvent = {
        id:        `gh_pr_${pr?.number || Date.now()}`,
        type:      `git.pr_${payload.action || 'opened'}`,
        source:    'github-webhook',
        sessionId: payload.repository?.name || 'github',
        channelId: 'github',
        timestamp: pr?.updated_at || new Date().toISOString(),
        data: {
          summary: `PR #${pr?.number}: ${pr?.title}`,
          url:     pr?.html_url,
          state:   pr?.state,
          author:  pr?.user?.login,
          branch:  pr?.head?.ref,
        },
        metadata: { source: 'github', action: payload.action },
      };
      try { insertEvent(orbitEvent); } catch {}
    } else if (ghEvent === 'issues') {
      const issue = payload.issue;
      orbitEvent = {
        id:        `gh_issue_${issue?.number || Date.now()}`,
        type:      `git.issue_${payload.action || 'opened'}`,
        source:    'github-webhook',
        sessionId: payload.repository?.name || 'github',
        channelId: 'github',
        timestamp: issue?.updated_at || new Date().toISOString(),
        data: {
          summary: `Issue #${issue?.number}: ${issue?.title}`,
          url:     issue?.html_url,
          state:   issue?.state,
          author:  issue?.user?.login,
          labels:  issue?.labels?.map(l => l.name) || [],
        },
        metadata: { source: 'github', action: payload.action },
      };
      try { insertEvent(orbitEvent); } catch {}
    }

    if (orbitEvent) {
      broadcastAll({ type: 'new_event', event: orbitEvent });
    }

    res.json({ ok: true, processed: eventType });
  });

  // ─── 최근 Git 커밋 요약 ─────────────────────────────────────────────────────
  router.get('/git/summary', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    // insertEvent가 주입된 DB에서 git 이벤트 조회
    // 실제 구현에서는 db.getAllEvents()를 git 타입으로 필터링
    res.json({
      ok: true,
      message: 'Use /api/graph?type=git.commit to see git events in the graph',
      hint:    'Install git hooks: curl http://localhost:4747/api/git/install | bash',
      limit,
    });
  });

  // ─── Git Hooks 자동 설치 스크립트 ──────────────────────────────────────────
  // curl http://localhost:4747/api/git/install | bash
  router.get('/git/install', (req, res) => {
    const host = process.env.ORBIT_URL || `http://localhost:${process.env.PORT || 4747}`;

    const script = `#!/bin/bash
# ============================================================
# Orbit AI — Git Hooks 자동 설치 스크립트
# 실행: curl ${host}/api/git/install | bash
# ============================================================

ORBIT_HOST="${host}"
HOOKS_DIR="\$(git rev-parse --git-dir 2>/dev/null)/hooks"

if [ -z "\$HOOKS_DIR" ] || [ ! -d "\$HOOKS_DIR" ]; then
  echo "❌ Git 저장소가 아닙니다. git init 먼저 실행하세요."
  exit 1
fi

echo "📡 Orbit AI Git Hooks 설치 중... (\$HOOKS_DIR)"

# ── post-commit hook ──────────────────────────────────────
cat > "\$HOOKS_DIR/post-commit" << 'HOOK'
#!/bin/sh
HASH=\$(git rev-parse HEAD 2>/dev/null)
MSG=\$(git log -1 --pretty=%B 2>/dev/null | head -1)
FILES=\$(git diff-tree --no-commit-id -r --name-only HEAD 2>/dev/null | tr '\\n' ',' | sed 's/,$//')
BRANCH=\$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
AUTHOR=\$(git log -1 --pretty="%an" 2>/dev/null)
ORBIT_HOST_LOCAL=\$(cat "\$(git rev-parse --git-dir)/orbit-host" 2>/dev/null || echo "ORBIT_HOST_PLACEHOLDER")

curl -s -X POST "\${ORBIT_HOST_LOCAL}/api/git/hook" \\
  -H "Content-Type: application/json" \\
  -d "{\\"type\\":\\"commit\\",\\"summary\\":\\"\$MSG\\",\\"metadata\\":{\\"hash\\":\\"\$HASH\\",\\"files\\":\\"\$FILES\\",\\"branch\\":\\"\$BRANCH\\",\\"author\\":\\"\$AUTHOR\\"}}" \\
  --max-time 3 &
HOOK

# ── post-push hook ────────────────────────────────────────
cat > "\$HOOKS_DIR/post-push" << 'HOOK'
#!/bin/sh
REMOTE=\$1
BRANCH=\$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
HASH=\$(git rev-parse HEAD 2>/dev/null)
ORBIT_HOST_LOCAL=\$(cat "\$(git rev-parse --git-dir)/orbit-host" 2>/dev/null || echo "ORBIT_HOST_PLACEHOLDER")

curl -s -X POST "\${ORBIT_HOST_LOCAL}/api/git/hook" \\
  -H "Content-Type: application/json" \\
  -d "{\\"type\\":\\"push\\",\\"summary\\":\\"Push to \$REMOTE/\$BRANCH\\",\\"metadata\\":{\\"hash\\":\\"\$HASH\\",\\"branch\\":\\"\$BRANCH\\",\\"remote\\":\\"\$REMOTE\\"}}" \\
  --max-time 3 &
HOOK

# ── post-merge hook ───────────────────────────────────────
cat > "\$HOOKS_DIR/post-merge" << 'HOOK'
#!/bin/sh
HASH=\$(git rev-parse HEAD 2>/dev/null)
BRANCH=\$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
ORBIT_HOST_LOCAL=\$(cat "\$(git rev-parse --git-dir)/orbit-host" 2>/dev/null || echo "ORBIT_HOST_PLACEHOLDER")

curl -s -X POST "\${ORBIT_HOST_LOCAL}/api/git/hook" \\
  -H "Content-Type: application/json" \\
  -d "{\\"type\\":\\"merge\\",\\"summary\\":\\"Merge into \$BRANCH\\",\\"metadata\\":{\\"hash\\":\\"\$HASH\\",\\"branch\\":\\"\$BRANCH\\"}}" \\
  --max-time 3 &
HOOK

# Orbit 호스트 저장
echo "${host}" > "\$HOOKS_DIR/../orbit-host"

# 실행 권한 부여
chmod +x "\$HOOKS_DIR/post-commit" "\$HOOKS_DIR/post-push" "\$HOOKS_DIR/post-merge"

echo "✅ Orbit AI Git Hooks 설치 완료!"
echo "   - post-commit  → ${host}/api/git/hook"
echo "   - post-push    → ${host}/api/git/hook"
echo "   - post-merge   → ${host}/api/git/hook"
echo ""
echo "   이제 git commit 할 때마다 Orbit 뉴런 맵에 자동 기록됩니다."
`;

    // ORBIT_HOST_PLACEHOLDER를 실제 호스트로 치환
    const finalScript = script.replace(/ORBIT_HOST_PLACEHOLDER/g, host);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="orbit-git-install.sh"');
    res.send(finalScript);
  });

  return router;
}

module.exports = createRouter;
