/**
 * Orbit AI Tracker — VS Code Extension
 * ─────────────────────────────────────────────────────────────
 * VS Code 작업 내역을 로컬 Orbit 서버(localhost:4747)로 전송
 *
 * 수집 항목:
 *   - 파일 저장 (언어, 줄 수)
 *   - 활성 에디터 전환 (어떤 파일 보고 있는지)
 *   - 디버그 시작/종료
 *   - 터미널 명령어 (VS Code 내장 터미널)
 *   - Git 작업 (저장 시 변경 감지)
 * ─────────────────────────────────────────────────────────────
 */
'use strict';

const vscode = require('vscode');
const http   = require('http');
const https  = require('https');
const path   = require('path');

// ── 설정 읽기 (URL, 토큰, 활성화) ────────────────────────────
function cfg() {
  const c = vscode.workspace.getConfiguration('orbit');
  const serverUrl = c.get('serverUrl', '');
  const port      = c.get('serverPort', 4747);
  return {
    url:     serverUrl ? serverUrl.replace(/\/+$/, '') : `http://127.0.0.1:${port}`,
    token:   c.get('token', ''),
    enabled: c.get('enabled', true),
  };
}

// ── 서버로 이벤트 전송 (HTTP/HTTPS 자동 선택) ────────────────
function send(type, data) {
  const { url, token, enabled } = cfg();
  if (!enabled) return;

  try {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const isRemote = parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost';
    const payload = JSON.stringify({
      type,
      data: { ...data, source: 'vscode' },
      timestamp: new Date().toISOString(),
      ...(isRemote ? { fromRemote: true } : {}),
    });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const mod = isHttps ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     '/api/vscode-activity',
      method:   'POST',
      headers,
    }, r => r.resume());
    req.on('error', () => {});            // 서버 꺼져있으면 조용히 무시
    req.setTimeout(3000, () => req.destroy());
    req.write(payload);
    req.end();
  } catch {}
}

// ── 파일 경로에서 언어 감지 헬퍼 ────────────────────────────
function getLang(doc) {
  return doc.languageId || path.extname(doc.fileName).replace('.', '') || 'unknown';
}

// ── 익스텐션 활성화 ────────────────────────────────────────
function activate(context) {
  console.log('[Orbit] VS Code 트래커 시작');

  // ① 파일 저장
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      send('file_save', {
        filePath:  doc.fileName,
        language:  getLang(doc),
        lineCount: doc.lineCount,
        fileName:  path.basename(doc.fileName),
      });
    })
  );

  // ② 활성 에디터 전환 (디바운스 1초 — 빠른 탭 이동 무시)
  let _editorTimer = null;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (!editor || editor.document.isUntitled) return;
      clearTimeout(_editorTimer);
      _editorTimer = setTimeout(() => {
        send('file_open', {
          filePath: editor.document.fileName,
          language: getLang(editor.document),
          fileName: path.basename(editor.document.fileName),
        });
      }, 1000);
    })
  );

  // ③ 디버그 시작
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(session => {
      send('debug_start', {
        name: session.name,
        type: session.type,
      });
    })
  );

  // ④ 디버그 종료
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(session => {
      send('debug_end', {
        name: session.name,
        type: session.type,
      });
    })
  );

  // ⑤ 터미널 생성 (VS Code 내장 터미널)
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(terminal => {
      send('terminal_open', { name: terminal.name });
    })
  );

  // ⑥ 워크스페이스 폴더 변경 (프로젝트 전환)
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(e => {
      if (e.added.length > 0) {
        send('workspace_open', {
          name: e.added[0].name,
          path: e.added[0].uri.fsPath,
        });
      }
    })
  );

  // ⑦ 익스텐션 시작 시 현재 워크스페이스 보고
  const ws = vscode.workspace.workspaceFolders;
  if (ws && ws.length > 0) {
    send('workspace_open', {
      name:   ws[0].name,
      path:   ws[0].uri.fsPath,
      onLoad: true,
    });
  }
}

function deactivate() {
  console.log('[Orbit] VS Code 트래커 종료');
}

module.exports = { activate, deactivate };
