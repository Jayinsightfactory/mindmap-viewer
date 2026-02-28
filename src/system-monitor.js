/**
 * system-monitor.js — 시스템 전반 작업 감지 모듈
 *
 * 감지 대상:
 *  - 활성 앱 전환  (macOS: osascript / Windows: PowerShell)
 *  - 활성 창 타이틀 변경
 *  - 클립보드 변경
 *  - 브라우저 활성 탭 URL (Chrome DevTools Protocol 로컬 연결)
 *  - 유휴(idle) 감지
 *
 * 이벤트 형식:
 *  { type: 'app_switch'|'browse'|'clipboard'|'document'|'meeting'|'idle'|'file',
 *    app, title, url, text, timestamp, platform }
 */

'use strict';

const { EventEmitter } = require('events');
const { exec, execSync } = require('child_process');
const os   = require('os');
const http = require('http');

const POLL_INTERVAL_MS  = 2000;   // 앱/창 전환 폴링 주기
const CLIP_INTERVAL_MS  = 1500;   // 클립보드 폴링 주기
const IDLE_THRESHOLD_MS = 120000; // 2분 무활동 → idle 이벤트
const CDP_PORT          = 9222;   // Chrome --remote-debugging-port

// ── 카테고리 분류 규칙 ─────────────────────────────────────────────────────────
const APP_CATEGORY_MAP = [
  // [정규식(앱명+타이틀 검사), category, activityType]
  [/chrome|edge|firefox|safari|brave/i,      'browse',   'browse'],
  [/word|한글|hwp|pages|docs/i,             'document', 'document'],
  [/excel|numbers|sheets|calc/i,            'analysis', 'document'],
  [/powerpoint|keynote|impress/i,           'document', 'document'],
  [/zoom|teams|meet|webex|slack|discord/i,  'meeting',  'meeting'],
  [/notion|obsidian|bear|evernote|typora/i, 'docs',     'document'],
  [/vscode|cursor|zed|sublime|vim|emacs|idea|xcode/i, 'feature', 'file'],
  [/terminal|iterm|warp|hyper|powershell|cmd/i, 'config', 'file'],
  [/figma|sketch|xd|illustrator|photoshop/i, 'docs',    'document'],
  [/mail|outlook|thunderbird/i,             'report',   'document'],
  [/jira|linear|asana|trello|basecamp/i,    'feature',  'browse'],
];

// 브라우저 URL 분류
const URL_CATEGORY_MAP = [
  [/github\.com|gitlab\.com|bitbucket/i,    'feature',  'browse'],
  [/stackoverflow|developer\.mozilla/i,     'bugfix',   'browse'],
  [/docs\.|documentation\.|readme/i,        'docs',     'browse'],
  [/figma\.com|sketch\.cloud/i,             'docs',     'browse'],
  [/jira\.|linear\.app|asana\.com/i,        'feature',  'browse'],
  [/mail\.|gmail\.|outlook\.live/i,         'report',   'browse'],
  [/meet\.google|zoom\.us|teams\.microsoft/i, 'meeting','browse'],
  [/analytics|dashboard|tableau|metabase/i, 'analysis', 'browse'],
  [/youtube|netflix|twitch/i,               null,       null],  // 무시
];

// ─────────────────────────────────────────────────────────────────────────────

class SystemMonitor extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.platform       = os.platform(); // 'darwin' | 'win32' | 'linux'
    this._pollTimer     = null;
    this._clipTimer     = null;
    this._idleTimer     = null;
    this._lastApp       = '';
    this._lastTitle     = '';
    this._lastClip      = '';
    this._lastActivity  = Date.now();
    this._cdpTabId      = null;
    this._running       = false;
    this._cdpEnabled    = opts.cdp !== false;
    this._appEnabled    = opts.app !== false;
    this._clipEnabled   = opts.clipboard !== false;
  }

  // ── 시작 ──────────────────────────────────────────────────────────────────
  start() {
    if (this._running) return;
    this._running = true;

    if (this._appEnabled) {
      this._pollTimer = setInterval(() => this._pollActiveApp(), POLL_INTERVAL_MS);
    }
    if (this._clipEnabled) {
      this._clipTimer = setInterval(() => this._pollClipboard(), CLIP_INTERVAL_MS);
    }
    // idle 체크 (폴링 기반)
    this._idleTimer = setInterval(() => this._checkIdle(), 10000);

    console.log(`[SystemMonitor] 시작 — 플랫폼:${this.platform}, CDP:${this._cdpEnabled}`);
    return this;
  }

  stop() {
    this._running = false;
    clearInterval(this._pollTimer);
    clearInterval(this._clipTimer);
    clearInterval(this._idleTimer);
    console.log('[SystemMonitor] 정지');
  }

  // ── 활성 앱 + 창 타이틀 폴링 ───────────────────────────────────────────────
  async _pollActiveApp() {
    try {
      const { app, title } = await this._getActiveWindow();
      if (!app) return;

      const appChanged   = app   !== this._lastApp;
      const titleChanged = title !== this._lastTitle;
      if (!appChanged && !titleChanged) return;

      this._lastApp   = app;
      this._lastTitle = title;
      this._bump();

      const cat = this._classifyApp(app, title);
      if (!cat) return; // 무시 카테고리

      const ev = {
        type:         'app_switch',
        app,
        title,
        category:     cat.category,
        activityType: cat.activityType,
        timestamp:    Date.now(),
        platform:     this.platform,
      };

      // 브라우저 → URL 추가 획득 (CDP)
      if (/chrome|edge|brave/i.test(app) && this._cdpEnabled) {
        const url = await this._getCdpUrl();
        if (url) {
          ev.url = url;
          const urlCat = this._classifyUrl(url);
          if (urlCat) {
            ev.category     = urlCat.category;
            ev.activityType = urlCat.activityType;
            ev.type         = 'browse';
          }
        }
      }

      this.emit('activity', ev);
    } catch (_) { /* ignore */ }
  }

  // ── 플랫폼별 활성 창 조회 ──────────────────────────────────────────────────
  _getActiveWindow() {
    return new Promise((resolve) => {
      if (this.platform === 'darwin') {
        // macOS: osascript
        const script = `
          tell application "System Events"
            set fApp to name of first application process whose frontmost is true
            set fTitle to ""
            try
              set fTitle to name of front window of (first application process whose frontmost is true)
            end try
          end tell
          return fApp & "|||" & fTitle
        `;
        exec(`osascript -e '${script.replace(/\n/g, ' ')}'`, (err, stdout) => {
          if (err) return resolve({ app: '', title: '' });
          const [app, title] = stdout.trim().split('|||');
          resolve({ app: (app || '').trim(), title: (title || '').trim() });
        });
      } else if (this.platform === 'win32') {
        // Windows: PowerShell
        const ps = `
          Add-Type @"
          using System; using System.Runtime.InteropServices;
          public class WinAPI {
            [DllImport("user32")] public static extern IntPtr GetForegroundWindow();
            [DllImport("user32")] public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder s,int m);
            [DllImport("user32")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
          }
"@
          $h = [WinAPI]::GetForegroundWindow()
          $sb = New-Object System.Text.StringBuilder 256
          [WinAPI]::GetWindowText($h, $sb, 256) | Out-Null
          $pid = 0; [WinAPI]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null
          $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
          Write-Output ($proc.ProcessName + "|||" + $sb.ToString())
        `;
        exec(`powershell -Command "${ps.replace(/"/g, '\\"')}"`, (err, stdout) => {
          if (err) return resolve({ app: '', title: '' });
          const [app, title] = stdout.trim().split('|||');
          resolve({ app: (app || '').trim(), title: (title || '').trim() });
        });
      } else {
        // Linux: xdotool (설치 필요)
        exec('xdotool getactivewindow getwindowname', (err, stdout) => {
          resolve({ app: '', title: (stdout || '').trim() });
        });
      }
    });
  }

  // ── 클립보드 폴링 ──────────────────────────────────────────────────────────
  async _pollClipboard() {
    try {
      const text = await this._readClipboard();
      if (!text || text === this._lastClip) return;
      if (text.length > 4000) { this._lastClip = text; return; } // 너무 긴 바이너리 무시

      this._lastClip = text;
      this._bump();

      // URL인지 확인
      const isUrl = /^https?:\/\/\S+$/.test(text.trim());
      const cat   = isUrl
        ? (this._classifyUrl(text) || { category: 'browse',  activityType: 'browse' })
        : { category: 'document', activityType: 'document' };

      this.emit('activity', {
        type:         'clipboard',
        text:         text.slice(0, 200),
        category:     cat.category,
        activityType: cat.activityType,
        url:          isUrl ? text.trim() : undefined,
        timestamp:    Date.now(),
        platform:     this.platform,
      });
    } catch (_) { /* ignore */ }
  }

  _readClipboard() {
    return new Promise((resolve) => {
      let cmd;
      if (this.platform === 'darwin') cmd = 'pbpaste';
      else if (this.platform === 'win32') cmd = 'powershell Get-Clipboard';
      else cmd = 'xclip -o -selection clipboard 2>/dev/null || xsel --clipboard --output 2>/dev/null';

      exec(cmd, { maxBuffer: 128 * 1024 }, (err, stdout) => {
        resolve(err ? '' : (stdout || ''));
      });
    });
  }

  // ── Chrome DevTools Protocol — 활성 탭 URL ────────────────────────────────
  _getCdpUrl() {
    return new Promise((resolve) => {
      const req = http.get(
        { hostname: '127.0.0.1', port: CDP_PORT, path: '/json', timeout: 800 },
        (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try {
              const tabs = JSON.parse(data);
              const active = tabs.find(t => t.type === 'page' && !t.url.startsWith('chrome'));
              resolve(active?.url || null);
            } catch { resolve(null); }
          });
        }
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  // ── 카테고리 분류 헬퍼 ────────────────────────────────────────────────────
  _classifyApp(app, title) {
    const combined = `${app} ${title}`.toLowerCase();
    for (const [re, category, activityType] of APP_CATEGORY_MAP) {
      if (re.test(combined)) {
        return { category, activityType };
      }
    }
    return { category: 'unknown', activityType: 'app_switch' };
  }

  _classifyUrl(url) {
    for (const [re, category, activityType] of URL_CATEGORY_MAP) {
      if (re.test(url)) {
        if (!category) return null; // 무시 (유튜브 등)
        return { category, activityType };
      }
    }
    return { category: 'browse', activityType: 'browse' };
  }

  // ── 유휴 감지 ─────────────────────────────────────────────────────────────
  _checkIdle() {
    if (Date.now() - this._lastActivity > IDLE_THRESHOLD_MS) {
      this.emit('activity', {
        type:         'idle',
        category:     'unknown',
        activityType: 'idle',
        idleSec:      Math.floor((Date.now() - this._lastActivity) / 1000),
        timestamp:    Date.now(),
        platform:     this.platform,
      });
      // 반복 방지: idle 이후엔 bump하지 않음 (다음 실제 활동 때까지)
      this._lastActivity = Date.now();
    }
  }

  _bump() {
    this._lastActivity = Date.now();
  }
}

// ── 싱글턴 ──────────────────────────────────────────────────────────────────
let _instance = null;

function getInstance(opts) {
  if (!_instance) _instance = new SystemMonitor(opts);
  return _instance;
}

module.exports = { SystemMonitor, getInstance };
