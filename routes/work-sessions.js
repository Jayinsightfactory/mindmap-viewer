/**
 * routes/work-sessions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Claude 작업 세션 이력 API
 *
 * GET /api/sessions/commits    — Git 커밋 기록
 * GET /api/sessions/summary    — 세션 메모리 파일 요약
 * GET /api/sessions/timeline   — 날짜별 그룹핑된 타임라인
 * GET /api/sessions/files      — 최근 변경 파일 목록
 * GET /api/sessions/stats      — 통계 (커밋/줄/파일 수)
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const express = require('express');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO_DIR = path.resolve(__dirname, '..');

// ─── 헬퍼: git 명령 실행 ─────────────────────────────────────────────────────
function git(cmd, opts = {}) {
  try {
    return execSync(`git ${cmd}`, {
      cwd: REPO_DIR,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15000,
      ...opts,
    }).trim();
  } catch (e) {
    return '';
  }
}

// ─── 커밋 메시지 → 카테고리 분류 ─────────────────────────────────────────────
function categorize(subject) {
  const s = (subject || '').toLowerCase();
  if (s.startsWith('feat:') || s.startsWith('feat('))   return { key: 'feat',     label: '신규 기능',   color: '#3fb950' };
  if (s.startsWith('fix:')  || s.startsWith('fix('))    return { key: 'fix',      label: '버그 수정',   color: '#ffa657' };
  if (s.startsWith('refactor:') || s.startsWith('refactor(')) return { key: 'refactor', label: '리팩토링', color: '#58a6ff' };
  if (s.startsWith('style:') || s.startsWith('style(')) return { key: 'style',    label: '스타일',     color: '#bc8cff' };
  if (s.startsWith('docs:')  || s.startsWith('docs('))  return { key: 'docs',     label: '문서',       color: '#39d2c0' };
  if (s.startsWith('security:') || s.startsWith('sec:')) return { key: 'security', label: '보안',       color: '#f85149' };
  if (s.startsWith('chore:') || s.startsWith('chore(')) return { key: 'chore',    label: '유지보수',   color: '#8b949e' };
  return { key: 'other', label: '기타', color: '#8b949e' };
}

// ─── 커밋 상세 파싱 ──────────────────────────────────────────────────────────
function parseCommits({ since, until, limit = 50 } = {}) {
  let dateFilter = '';
  if (since) dateFilter += ` --since="${since}"`;
  if (until) dateFilter += ` --until="${until}"`;

  // 커밋 해시 목록 가져오기
  const hashesRaw = git(`log --format="%H" ${dateFilter} -${limit}`);
  if (!hashesRaw) return [];

  const hashes = hashesRaw.split('\n').filter(Boolean);
  const commits = [];

  for (const fullHash of hashes) {
    // 기본 정보
    const info = git(`log -1 --format="%h%n%ci%n%s%n%b" ${fullHash}`);
    const lines = info.split('\n');
    const hash = lines[0] || '';
    const date = lines[1] || '';
    const subject = lines[2] || '';
    const body = lines.slice(3).join('\n').trim();

    // 변경 파일 + stat
    const statRaw = git(`show --stat --format="" ${fullHash}`);
    const statLines = statRaw.split('\n').filter(Boolean);

    // 마지막 줄: "X files changed, Y insertions(+), Z deletions(-)"
    const summaryLine = statLines[statLines.length - 1] || '';
    const filesChanged = parseInt((summaryLine.match(/(\d+) files? changed/) || [])[1]) || 0;
    const insertions   = parseInt((summaryLine.match(/(\d+) insertions?\(\+\)/) || [])[1]) || 0;
    const deletions    = parseInt((summaryLine.match(/(\d+) deletions?\(-\)/) || [])[1]) || 0;

    // 파일 목록 (stat 줄에서 파일명 추출)
    const files = [];
    for (let i = 0; i < statLines.length - 1; i++) {
      const m = statLines[i].match(/^\s*(.+?)\s+\|\s+/);
      if (m) files.push(m[1].trim());
    }

    // 파일 상태 (A/M/D)
    const nameStatusRaw = git(`diff-tree --no-commit-id --name-status -r ${fullHash}`);
    const fileDetails = [];
    if (nameStatusRaw) {
      for (const line of nameStatusRaw.split('\n').filter(Boolean)) {
        const parts = line.split('\t');
        if (parts.length >= 2) {
          const status = parts[0].charAt(0);
          const fname = parts[1];
          const statusLabel = status === 'A' ? '신규' : status === 'D' ? '삭제' : '수정';
          fileDetails.push({ file: fname, status, statusLabel });
        }
      }
    }

    const cat = categorize(subject);

    commits.push({
      hash,
      fullHash,
      date,
      subject,
      body: body || undefined,
      category: cat,
      filesChanged,
      insertions,
      deletions,
      files,
      fileDetails,
    });
  }

  return commits;
}

// ─── 세션 메모리 파일 읽기 ───────────────────────────────────────────────────
function readSessionSummaries() {
  const candidates = [
    path.join(__dirname, '../.claude/projects/-Users-darlene/memory'),
    path.resolve('/Users/darlene/.claude/projects/-Users-darlene/memory'),
  ];

  let memoryDir = null;
  for (const dir of candidates) {
    if (fs.existsSync(dir)) { memoryDir = dir; break; }
  }
  if (!memoryDir) return [];

  const files = fs.readdirSync(memoryDir).filter(f => f.startsWith('project_session_') && f.endsWith('.md'));
  const summaries = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(memoryDir, file), 'utf-8');

      // frontmatter 파싱
      let name = '', description = '';
      const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fm = fmMatch[1];
        const nameM = fm.match(/name:\s*(.+)/);
        const descM = fm.match(/description:\s*(.+)/);
        if (nameM) name = nameM[1].trim();
        if (descM) description = descM[1].trim();
      }

      // 본문에서 핵심 섹션 추출
      const sections = [];
      const sectionMatches = content.matchAll(/^##\s+(.+)/gm);
      for (const m of sectionMatches) {
        sections.push(m[1].trim());
      }

      // 핵심 수치 추출
      const metricsSection = content.match(/### 핵심 수치[\s\S]*?(?=###|$)/);
      const metrics = metricsSection ? metricsSection[0].trim() : '';

      // 다음에 해야 할 것 추출
      const nextSection = content.match(/### 다음에 해야 할 것[\s\S]*?(?=###|\*\*Why|$)/);
      const nextSteps = nextSection ? nextSection[0].trim() : '';

      summaries.push({
        file,
        name: name || file.replace('.md', ''),
        description,
        sections,
        metrics,
        nextSteps,
        contentLength: content.length,
      });
    } catch (e) {
      // skip unreadable files
    }
  }

  return summaries.sort((a, b) => b.file.localeCompare(a.file));
}

// ─── 라우터 팩토리 ──────────────────────────────────────────────────────────
module.exports = function workSessionsRoute(/* { getDb } */) {
  const router = express.Router();

  // ── GET /commits ─────────────────────────────────────────────────────────
  router.get('/commits', (req, res) => {
    try {
      const { since, until, limit = 50, category } = req.query;
      let commits = parseCommits({ since, until, limit: parseInt(limit) || 50 });

      if (category) {
        commits = commits.filter(c => c.category.key === category);
      }

      res.json({ ok: true, count: commits.length, commits });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /summary ─────────────────────────────────────────────────────────
  router.get('/summary', (req, res) => {
    try {
      const summaries = readSessionSummaries();
      res.json({ ok: true, count: summaries.length, summaries });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /timeline ────────────────────────────────────────────────────────
  router.get('/timeline', (req, res) => {
    try {
      const { since, limit = 100 } = req.query;
      const commits = parseCommits({ since, limit: parseInt(limit) || 100 });

      // 날짜별 그룹핑 (YYYY-MM-DD)
      const timeline = {};
      for (const c of commits) {
        const day = c.date.substring(0, 10); // "2026-03-22"
        if (!timeline[day]) timeline[day] = [];
        timeline[day].push(c);
      }

      // 날짜 목록 (내림차순)
      const dates = Object.keys(timeline).sort((a, b) => b.localeCompare(a));

      res.json({ ok: true, dates, timeline });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /files ───────────────────────────────────────────────────────────
  router.get('/files', (req, res) => {
    try {
      const n = parseInt(req.query.n) || 10;
      const raw = git(`diff --name-status HEAD~${n} HEAD`);
      if (!raw) return res.json({ ok: true, files: [] });

      const files = [];
      for (const line of raw.split('\n').filter(Boolean)) {
        const parts = line.split('\t');
        if (parts.length >= 2) {
          const status = parts[0].charAt(0);
          const fname = parts[1];
          const statusLabel = status === 'A' ? '추가' : status === 'D' ? '삭제' : '수정';
          files.push({ file: fname, status, statusLabel });
        }
      }

      res.json({ ok: true, count: files.length, n, files });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── GET /stats ───────────────────────────────────────────────────────────
  router.get('/stats', (req, res) => {
    try {
      const { since } = req.query;
      const commits = parseCommits({ since, limit: 500 });

      // 기본 통계
      const totalCommits = commits.length;
      let totalInsertions = 0, totalDeletions = 0;
      const fileSet = new Set();
      const categoryCount = {};
      const fileChangeCount = {};

      // 이번 주 커밋 수
      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      weekStart.setHours(0, 0, 0, 0);
      let weekCommits = 0;

      for (const c of commits) {
        totalInsertions += c.insertions;
        totalDeletions += c.deletions;

        for (const f of c.files) {
          fileSet.add(f);
          fileChangeCount[f] = (fileChangeCount[f] || 0) + 1;
        }

        const catKey = c.category.key;
        categoryCount[catKey] = (categoryCount[catKey] || 0) + 1;

        const commitDate = new Date(c.date);
        if (commitDate >= weekStart) weekCommits++;
      }

      // 가장 많이 변경된 파일 (top 10)
      const mostChanged = Object.entries(fileChangeCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([file, count]) => ({ file, count }));

      // 카테고리 상세
      const categories = Object.entries(categoryCount).map(([key, count]) => {
        const cat = categorize(key + ':');
        return { key, label: cat.label, color: cat.color, count };
      });

      res.json({
        ok: true,
        totalCommits,
        weekCommits,
        totalFiles: fileSet.size,
        totalInsertions,
        totalDeletions,
        categories,
        mostChanged,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/sessions/conversations — Claude 대화 기록 (프로젝트별 분류)
  // ═══════════════════════════════════════════════════════════════════════════
  const CONV_FILE = path.join(__dirname, '..', '..', 'orbit', 'src', 'conversation.jsonl');

  router.get('/conversations', async (req, res) => {
    try {
      if (!fs.existsSync(CONV_FILE)) {
        return res.json({ ok: true, sessions: [], total: 0, message: 'conversation.jsonl 없음' });
      }

      const lines = fs.readFileSync(CONV_FILE, 'utf-8').split('\n').filter(Boolean);
      const sessMap = {};

      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          const sid = ev.sessionId;
          if (!sid) continue;

          if (!sessMap[sid]) {
            sessMap[sid] = {
              sessionId: sid,
              startTime: ev.ts || null,
              endTime: ev.ts || null,
              messages: [],
              tools: [],
              files: [],
              subagents: 0,
              project: '미분류',
            };
          }
          const s = sessMap[sid];
          if (ev.ts) {
            if (!s.startTime || ev.ts < s.startTime) s.startTime = ev.ts;
            if (!s.endTime || ev.ts > s.endTime) s.endTime = ev.ts;
          }

          if (ev.type === 'user.message' && ev.data?.contentPreview) {
            s.messages.push({ role: 'user', text: ev.data.contentPreview.substring(0, 200), ts: ev.ts });
          }
          if (ev.type === 'assistant.message' && ev.data?.contentPreview) {
            s.messages.push({ role: 'assistant', text: ev.data.contentPreview.substring(0, 200), ts: ev.ts });
          }
          if (ev.type === 'file.write' && ev.data?.filePath) {
            const fp = ev.data.filePath.replace(/.*mindmap-viewer\//, '');
            if (!s.files.includes(fp)) s.files.push(fp);
          }
          if (ev.type === 'file.read' && ev.data?.filePath) {
            const fp = ev.data.filePath.replace(/.*mindmap-viewer\//, '');
            if (!s.files.includes(fp) && s.files.length < 20) s.files.push(fp);
          }
          if (ev.type === 'tool.end' && ev.data?.toolName) {
            if (!s.tools.includes(ev.data.toolName)) s.tools.push(ev.data.toolName);
          }
          if (ev.type === 'subagent.start') s.subagents++;
        } catch {}
      }

      // 프로젝트 분류
      const sessions = Object.values(sessMap).map(s => {
        // 첫 번째 사용자 메시지 + 파일 경로로 프로젝트 추정
        const allText = s.messages.map(m => m.text).join(' ') + ' ' + s.files.join(' ');
        const t = allText.toLowerCase();

        if (t.includes('사고') || t.includes('think') || t.includes('예측')) s.project = '사고 엔진';
        else if (t.includes('nenova') || t.includes('전산') || t.includes('sql server')) s.project = 'nenova 전산';
        else if (t.includes('3d') || t.includes('three') || t.includes('orbit3d') || t.includes('구체')) s.project = '3D UI';
        else if (t.includes('daemon') || t.includes('데몬') || t.includes('설치') || t.includes('updater')) s.project = '데몬/설치';
        else if (t.includes('vision') || t.includes('캡처') || t.includes('분석')) s.project = 'Vision 분석';
        else if (t.includes('카카오') || t.includes('카톡') || t.includes('kakao')) s.project = '카카오톡';
        else if (t.includes('pad') || t.includes('자동화') || t.includes('pyautogui')) s.project = '자동화';
        else if (t.includes('대시보드') || t.includes('dashboard') || t.includes('admin')) s.project = '대시보드';
        else if (t.includes('workspace') || t.includes('워크스페이스')) s.project = '워크스페이스';
        else if (t.includes('graph') || t.includes('마인드맵')) s.project = '그래프/마인드맵';
        else if (t.includes('auth') || t.includes('로그인') || t.includes('oauth')) s.project = '인증';
        else if (t.includes('report') || t.includes('리포트') || t.includes('sheets')) s.project = '리포트';
        else if (s.files.some(f => f.includes('route'))) s.project = 'API 개발';
        else s.project = '기타';

        return {
          sessionId: s.sessionId,
          project: s.project,
          startTime: s.startTime,
          endTime: s.endTime,
          duration: s.startTime && s.endTime ? Math.round((new Date(s.endTime) - new Date(s.startTime)) / 60000) : 0,
          messageCount: s.messages.length,
          firstMessage: s.messages[0]?.text || '',
          fileCount: s.files.length,
          files: s.files.slice(0, 10),
          tools: s.tools,
          subagents: s.subagents,
        };
      });

      // 최신순 정렬
      sessions.sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''));

      // 프로젝트별 집계
      const projects = {};
      for (const s of sessions) {
        if (!projects[s.project]) projects[s.project] = { name: s.project, sessionCount: 0, totalMessages: 0, totalFiles: 0 };
        projects[s.project].sessionCount++;
        projects[s.project].totalMessages += s.messageCount;
        projects[s.project].totalFiles += s.fileCount;
      }

      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const project = req.query.project;
      let filtered = sessions;
      if (project && project !== '전체') {
        filtered = sessions.filter(s => s.project === project);
      }

      res.json({
        ok: true,
        total: sessions.length,
        projects: Object.values(projects).sort((a, b) => b.sessionCount - a.sessionCount),
        sessions: filtered.slice(0, limit),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
};
