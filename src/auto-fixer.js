'use strict';
/**
 * auto-fixer.js — 에러 자동 감지 → 분석 → 수정 명령 전송
 *
 * daemon.error 이벤트 수신 시:
 *  1. 에러 패턴 매칭 (기존 알려진 패턴)
 *  2. 매칭되면 자동 fix 명령을 해당 PC에 큐잉
 *  3. 미지 에러는 로그 + 관리자 알림
 *  4. 수정 이력 추적
 */

const os = require('os');
const path = require('path');

// ── 에러 패턴 → 자동 수정 매핑 ──────────────────────────────────────────────
// 패턴: { match: RegExp | Function, fix: Object, description: string }
const FIX_PATTERNS = [
  // 1. node.exe 경로 문제
  {
    id: 'node-not-found',
    match: /node.*찾을 수 없|node.*not found|'node'.*recognized|ENOENT.*node/i,
    fix: {
      action: 'exec',
      command: `
        $nodePaths = @("C:\\Program Files\\nodejs\\node.exe", "$env:APPDATA\\nvm\\current\\node.exe", "$env:LOCALAPPDATA\\Programs\\nodejs\\node.exe")
        $found = $false
        foreach ($p in $nodePaths) {
          if (Test-Path $p) {
            $env:PATH = (Split-Path $p) + ";" + $env:PATH
            [System.Environment]::SetEnvironmentVariable("PATH", (Split-Path $p) + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User"), "User")
            Write-Host "node.exe found at $p, PATH updated"
            $found = $true
            break
          }
        }
        if (-not $found) {
          Write-Host "Installing Node.js via winget..."
          winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements 2>$null
        }
      `.trim().replace(/\n\s+/g, '; '),
    },
    description: 'node.exe PATH 수정 또는 재설치',
    cooldown: 30 * 60 * 1000, // 30분 쿨다운
  },

  // 2. uiohook 네이티브 모듈 문제
  {
    id: 'uiohook-fail',
    match: /uiohook|napi.*keyboard|native.*module.*keyboard/i,
    fix: {
      action: 'exec',
      command: 'cd /d "%USERPROFILE%\\.orbit\\mindmap-viewer" && npm rebuild uiohook-napi 2>&1 || npm install uiohook-napi --build-from-source 2>&1',
    },
    description: 'uiohook 네이티브 모듈 재빌드',
    cooldown: 60 * 60 * 1000,
  },

  // 3. npm 모듈 누락
  {
    id: 'module-not-found',
    match: /Cannot find module|MODULE_NOT_FOUND/i,
    fix: {
      action: 'exec',
      command: 'cd /d "%USERPROFILE%\\.orbit\\mindmap-viewer" && npm install --production 2>&1',
    },
    description: 'npm 모듈 재설치',
    cooldown: 30 * 60 * 1000,
  },

  // 4. 토큰/인증 문제
  {
    id: 'auth-fail',
    match: /401|unauthorized|token.*invalid|token.*expired|ORBIT_TOKEN.*empty/i,
    fix: {
      action: 'config',
      data: { _needReauth: true },
    },
    description: '토큰 재인증 필요 플래그 설정',
    cooldown: 60 * 60 * 1000,
  },

  // 5. EACCES / 권한 문제
  {
    id: 'permission-denied',
    match: /EACCES|permission denied|access.*denied/i,
    fix: {
      action: 'exec',
      command: 'icacls "%USERPROFILE%\\.orbit" /grant:r "%USERNAME%":F /t /q 2>&1',
    },
    description: '.orbit 폴더 권한 복구',
    cooldown: 60 * 60 * 1000,
  },

  // 6. ENOSPC / 디스크 공간 부족
  {
    id: 'disk-full',
    match: /ENOSPC|no space|disk.*full/i,
    fix: {
      action: 'exec',
      command: `powershell.exe -WindowStyle Hidden -NonInteractive -Command "Remove-Item '$env:USERPROFILE\\.orbit\\captures\\*.png' -Force -EA SilentlyContinue; Remove-Item '$env:USERPROFILE\\.orbit\\daemon.log.old' -Force -EA SilentlyContinue; Get-ChildItem '$env:USERPROFILE\\.orbit\\captures' -Filter *.png -Recurse | Where-Object {$_.LastWriteTime -lt (Get-Date).AddDays(-3)} | Remove-Item -Force -EA SilentlyContinue"`,
    },
    description: '3일 이상 된 캡처 파일 정리',
    cooldown: 60 * 60 * 1000,
  },

  // 7. screen-capture 실패 (보안프로그램 충돌)
  {
    id: 'capture-blocked',
    match: /screen.*capture.*fail|screenshot.*blocked|capture.*denied/i,
    fix: {
      action: 'config',
      data: { captureEnabled: false, captureDisabledReason: 'auto-disabled: security software conflict' },
    },
    description: '캡처 일시 비활성화 (보안프로그램 충돌)',
    cooldown: 4 * 60 * 60 * 1000, // 4시간
  },

  // 8. keyboard-watcher 크래시
  {
    id: 'keyboard-crash',
    match: /keyboard.*watcher.*crash|keyboard.*watcher.*fail|uiohook.*crash/i,
    fix: { action: 'restart' },
    description: '데몬 재시작',
    cooldown: 10 * 60 * 1000,
  },

  // 9. 네트워크 연결 문제
  {
    id: 'network-fail',
    match: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo.*fail|network.*unreachable/i,
    fix: null, // 자동 수정 불가 — 로그만
    description: '네트워크 연결 불가 (자동 수정 불가)',
    cooldown: 30 * 60 * 1000,
  },

  // 10. uncaughtException / unhandledRejection
  {
    id: 'unhandled-crash',
    match: /uncaughtException|unhandledRejection/i,
    fix: { action: 'update' }, // 최신 코드로 업데이트 시도
    description: '미처리 예외 → 최신 버전 업데이트 시도',
    cooldown: 30 * 60 * 1000,
  },
];

// ── 쿨다운 추적 (메모리) ─────────────────────────────────────────────────────
// key: `${hostname}:${patternId}`, value: last fix timestamp
const _cooldowns = new Map();

// ── 수정 이력 ───────────────────────────────────────────────────────────────
const _fixHistory = [];
const MAX_HISTORY = 200;

// ── 메인: 에러 이벤트 분석 → 자동 수정 ──────────────────────────────────────
function analyzeAndFix(event, daemonCommands) {
  if (!event || event.type !== 'daemon.error') return null;

  const errorStr = [
    event.data?.error || '',
    event.data?.detail || '',
    event.data?.component || '',
  ].join(' ');

  const hostname = event.data?.hostname || 'unknown';

  for (const pattern of FIX_PATTERNS) {
    let matched = false;

    if (pattern.match instanceof RegExp) {
      matched = pattern.match.test(errorStr);
    } else if (typeof pattern.match === 'function') {
      matched = pattern.match(errorStr, event.data);
    }

    if (!matched) continue;

    // 쿨다운 체크
    const cooldownKey = `${hostname}:${pattern.id}`;
    const lastFix = _cooldowns.get(cooldownKey) || 0;
    const now = Date.now();

    if (now - lastFix < pattern.cooldown) {
      console.log(`[auto-fixer] ${hostname}: ${pattern.id} 쿨다운 중 (${Math.round((pattern.cooldown - (now - lastFix)) / 60000)}분 남음)`);
      return { matched: true, patternId: pattern.id, action: 'cooldown' };
    }

    // 수정 가능한 패턴
    if (pattern.fix) {
      // 명령 큐에 추가
      if (!daemonCommands[hostname]) daemonCommands[hostname] = [];
      daemonCommands[hostname].push({
        ...pattern.fix,
        ts: new Date().toISOString(),
        _autoFix: true,
        _patternId: pattern.id,
        _reason: pattern.description,
      });

      _cooldowns.set(cooldownKey, now);

      const record = {
        ts: new Date().toISOString(),
        hostname,
        patternId: pattern.id,
        description: pattern.description,
        error: errorStr.slice(0, 200),
        action: pattern.fix.action,
        status: 'queued',
      };
      _fixHistory.push(record);
      if (_fixHistory.length > MAX_HISTORY) _fixHistory.shift();

      console.log(`[auto-fixer] ✅ ${hostname}: ${pattern.id} → ${pattern.fix.action} 명령 큐잉 (${pattern.description})`);
      return { matched: true, patternId: pattern.id, action: 'fix-queued', fix: pattern.fix };
    }

    // 수정 불가 패턴 (로그만)
    const record = {
      ts: new Date().toISOString(),
      hostname,
      patternId: pattern.id,
      description: pattern.description,
      error: errorStr.slice(0, 200),
      action: 'none',
      status: 'logged',
    };
    _fixHistory.push(record);
    if (_fixHistory.length > MAX_HISTORY) _fixHistory.shift();

    console.log(`[auto-fixer] ⚠️ ${hostname}: ${pattern.id} 감지 (자동 수정 불가: ${pattern.description})`);
    return { matched: true, patternId: pattern.id, action: 'no-fix' };
  }

  // 미지 에러
  const record = {
    ts: new Date().toISOString(),
    hostname,
    patternId: 'unknown',
    description: '미지 에러',
    error: errorStr.slice(0, 200),
    action: 'none',
    status: 'unknown',
  };
  _fixHistory.push(record);
  if (_fixHistory.length > MAX_HISTORY) _fixHistory.shift();

  console.log(`[auto-fixer] ❓ ${hostname}: 미지 에러 — ${errorStr.slice(0, 100)}`);
  return { matched: false, patternId: 'unknown', action: 'none' };
}

// ── 수정 이력 조회 ──────────────────────────────────────────────────────────
function getFixHistory(limit = 50) {
  return _fixHistory.slice(-limit).reverse();
}

// ── 패턴 목록 조회 ──────────────────────────────────────────────────────────
function getPatterns() {
  return FIX_PATTERNS.map(p => ({
    id: p.id,
    description: p.description,
    hasFix: !!p.fix,
    cooldownMin: Math.round(p.cooldown / 60000),
  }));
}

// ── 쿨다운 초기화 ──────────────────────────────────────────────────────────
function resetCooldown(hostname, patternId) {
  if (hostname && patternId) {
    _cooldowns.delete(`${hostname}:${patternId}`);
  } else if (hostname) {
    for (const key of _cooldowns.keys()) {
      if (key.startsWith(hostname + ':')) _cooldowns.delete(key);
    }
  } else {
    _cooldowns.clear();
  }
}

module.exports = { analyzeAndFix, getFixHistory, getPatterns, resetCooldown, FIX_PATTERNS };
