/**
 * vscode-orbit.js
 * VS Code에서 Orbit 맵 연동하는 가장 간단한 방법
 *
 * ── 사용법 ────────────────────────────────────────────
 * VS Code 터미널에서:
 *   node vscode-orbit.js watch        ← 파일 변경 감지 + 맵 업데이트
 *   node vscode-orbit.js git          ← 현재 git 상태를 맵에 전송
 *   node vscode-orbit.js done "기능명" ← 작업 완료 노드 생성
 *   node vscode-orbit.js note "메모"  ← 메모 노드 생성
 *
 * ── VS Code tasks.json 연동 ────────────────────────────
 * .vscode/tasks.json에 추가하면 Ctrl+Shift+B로 실행:
 * {
 *   "label": "Orbit: 작업 완료",
 *   "type": "shell",
 *   "command": "node ${workspaceFolder}/vscode-orbit.js done '${input:taskName}'"
 * }
 *
 * ── 자동 실행 (VS Code 시작 시) ────────────────────────
 * settings.json에 추가:
 * "terminal.integrated.shellArgs.osx": ["-c", "node vscode-orbit.js watch &"]
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');
const { randomUUID } = require('crypto');

const PORT       = parseInt(process.env.MINDMAP_PORT || '4747');
const CHANNEL    = process.env.MINDMAP_CHANNEL || 'default';
const MEMBER     = process.env.MINDMAP_MEMBER  || require('os').userInfo().username;
const SESSION_ID = `vscode-${MEMBER}-${Date.now()}`;
const WORKSPACE  = process.cwd();

// ── HTTP 전송 ───────────────────────────────────────
function send(type, data, aiSource = 'vscode') {
  const body = JSON.stringify({
    id: randomUUID(), type, aiSource,
    sessionId: SESSION_ID,
    userId: MEMBER, channelId: CHANNEL,
    timestamp: new Date().toISOString(),
    data: { ...data, memberName: MEMBER },
    metadata: { aiSource, agentName: 'vscode-orbit' },
  });
  const req = http.request({
    hostname: 'localhost', port: PORT, path: '/api/ai-event',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => { res.on('data', () => {}); res.on('end', () => {}); });
  req.on('error', () => {});
  req.write(body); req.end();
}

// ── 명령어 처리 ─────────────────────────────────────
const [,, cmd, ...args] = process.argv;

switch (cmd) {

  case 'watch': {
    console.log(`[Orbit] 파일 감지 시작: ${WORKSPACE}`);
    console.log(`[Orbit] 채널: ${CHANNEL} | 멤버: ${MEMBER}`);
    console.log('[Orbit] Ctrl+C로 종료\n');

    // 세션 시작 알림
    send('session.start', { source: 'vscode', projectDir: WORKSPACE,
      memberName: MEMBER, modelId: 'vscode' });

    // 파일 변경 감지 (node.js 내장 fs.watch)
    const WATCH_EXT = new Set(['.js','.ts','.tsx','.jsx','.py','.go','.rs','.css','.html','.json','.md']);
    const debounce  = new Map();

    fs.watch(WORKSPACE, { recursive: true }, (evType, filename) => {
      if (!filename) return;
      const ext = path.extname(filename).toLowerCase();
      if (!WATCH_EXT.has(ext)) return;
      if (filename.includes('node_modules') || filename.includes('.git')) return;

      // 디바운스 300ms
      clearTimeout(debounce.get(filename));
      debounce.set(filename, setTimeout(() => {
        const absPath = path.join(WORKSPACE, filename);
        const exists  = fs.existsSync(absPath);
        const type    = evType === 'rename' ? (exists ? 'file.write' : 'tool.end') : 'file.write';
        const label   = TOOL_LABELS[evType] || evType;

        console.log(`[Orbit] ${exists ? '✏️' : '🗑'} ${filename}`);
        send(type, {
          toolName:  exists ? 'FileSave' : 'FileDelete',
          filePath:  absPath,
          fileName:  filename,
          language:  LANG_MAP[ext.slice(1)] || null,
        });
      }, 300));
    });

    // Git 상태 주기적 체크 (30초마다)
    setInterval(() => {
      try {
        const status = execSync('git status --short', { cwd: WORKSPACE, timeout: 3000 }).toString().trim();
        if (status) {
          const changed = status.split('\n').length;
          send('tool.end', { toolName: 'Git', gitOp: 'status',
            inputPreview: `변경 ${changed}개 파일`, message: status.slice(0, 100) });
        }
      } catch {}
    }, 30000);

    // 종료 시 세션 종료 알림
    process.on('SIGINT', () => {
      send('session.end', {});
      console.log('\n[Orbit] 세션 종료');
      process.exit(0);
    });
    break;
  }

  case 'git': {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: WORKSPACE }).toString().trim();
      const log    = execSync('git log --oneline -1', { cwd: WORKSPACE }).toString().trim();
      const status = execSync('git status --short', { cwd: WORKSPACE }).toString().trim();
      const changed = status ? status.split('\n').length : 0;

      send('tool.end', {
        toolName: 'Git', gitOp: 'status',
        inputPreview: `${branch} — ${log}`,
        message: `브랜치: ${branch}\n최근 커밋: ${log}\n변경: ${changed}개 파일`,
      });
      console.log(`[Orbit] Git 상태 전송: ${branch} (${changed}개 변경)`);
    } catch (e) {
      console.error('[Orbit] Git 오류:', e.message);
    }
    break;
  }

  case 'done': {
    const taskName = args.join(' ') || '작업 완료';
    send('task.complete', { taskName, toolName: taskName });
    console.log(`[Orbit] ✅ 완료: ${taskName}`);
    break;
  }

  case 'note': {
    const note = args.join(' ') || '메모';
    send('annotation.add', { label: note, description: note });
    console.log(`[Orbit] 📌 메모: ${note}`);
    break;
  }

  case 'start': {
    send('session.start', { source: 'vscode', projectDir: WORKSPACE, memberName: MEMBER });
    console.log(`[Orbit] 🚀 세션 시작: ${MEMBER}`);
    break;
  }

  default:
    console.log(`
Orbit VS Code 연동 도구
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
사용법:
  node vscode-orbit.js watch          파일 변경 자동 감지
  node vscode-orbit.js git            Git 상태 맵에 표시
  node vscode-orbit.js done "작업명"  완료 노드 생성
  node vscode-orbit.js note "메모"    메모 노드 생성

환경변수:
  MINDMAP_PORT    서버 포트 (기본: 4747)
  MINDMAP_CHANNEL 채널명 (기본: default)
  MINDMAP_MEMBER  이름 (기본: OS 사용자명)

예시:
  MINDMAP_MEMBER=dlaww node vscode-orbit.js watch
  node vscode-orbit.js done "로그인 기능 완성"
`);
}

const TOOL_LABELS = { rename: 'FileSave', change: 'FileSave' };
const LANG_MAP = {
  js:'JavaScript', ts:'TypeScript', tsx:'React TSX', jsx:'React JSX',
  py:'Python', go:'Go', rs:'Rust', css:'CSS', html:'HTML',
};
