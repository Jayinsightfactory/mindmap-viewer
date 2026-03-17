'use strict';
/**
 * vision-analyzer.js
 * Screenshot → Claude Vision 분석 → 활동 설명
 *
 * Claude Code 구독자 세션으로 Vision API 호출 (별도 API 키 불필요)
 * 방법: claude CLI를 직접 호출하여 이미지 분석
 *
 * 분석 결과 캐시: 같은 앱+윈도우 패턴은 재분석 안 함
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFile } = require('child_process');

// 분석 캐시 (앱+윈도우 → 결과)
const _analysisCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30분 캐시

// Claude CLI 경로 찾기
function findClaudeCli() {
  try {
    // 1. PATH에서 찾기
    const which = process.platform === 'win32' ? 'where claude' : 'which claude';
    return execSync(which, { timeout: 3000 }).toString().trim().split('\n')[0];
  } catch {}
  // 2. 일반적인 설치 경로
  const candidates = process.platform === 'win32'
    ? [path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'), 'C:\\Program Files\\nodejs\\claude.cmd']
    : [path.join(os.homedir(), '.nvm', 'versions', 'node', '*', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];
  for (const c of candidates) {
    try {
      const resolved = require('glob').sync(c)[0] || c;
      if (fs.existsSync(resolved)) return resolved;
    } catch {
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

let _claudePath = null;

/**
 * API 키 존재 여부 (하위호환 — Claude CLI 또는 API 키)
 */
function getApiKey() {
  // Claude CLI가 있으면 구독 사용
  if (!_claudePath) _claudePath = findClaudeCli();
  if (_claudePath) return 'claude-cli';
  // 폴백: API 키
  try {
    const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8'));
    return config.anthropicKey || config.claudeApiKey || process.env.ANTHROPIC_API_KEY || '';
  } catch { return process.env.ANTHROPIC_API_KEY || ''; }
}

/**
 * 캐시 키 생성 (앱+윈도우 조합)
 */
function _cacheKey(app, windowTitle) {
  return `${app || ''}::${(windowTitle || '').replace(/[-\d:/.]+/g, '').trim()}`;
}

/**
 * 스크린샷 분석
 * @param {string} imagePath - PNG 파일 경로
 * @param {Object} context - { app, windowTitle } 추가 컨텍스트
 * @returns {Promise<{description, activity, app, confidence, details}>}
 */
async function analyzeScreenshot(imagePath, context = {}) {
  // 캐시 확인
  const cKey = _cacheKey(context.app, context.windowTitle);
  const cached = _analysisCache.get(cKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.result;
  }

  if (!_claudePath) _claudePath = findClaudeCli();

  const prompt = `이 스크린샷을 분석해주세요.
현재 앱: ${context.app || '알 수 없음'}
윈도우: ${context.windowTitle || '알 수 없음'}

JSON으로 답변:
{
  "activity": "작업유형(코딩/문서작성/스프레드시트/프레젠테이션/웹검색/디자인/커뮤니케이션/데이터분석/기타)",
  "app": "앱 이름",
  "description": "구체적으로 뭘 하고 있는지 1줄 (예: VLOOKUP으로 A열→C열 매칭 중, 3월 매출 피벗테이블 생성 중)",
  "details": "화면에 보이는 주요 내용 2~3줄 (메뉴, 셀 내용, 탭 이름 등)",
  "confidence": 0.0~1.0
}`;

  let result = null;

  // 방법 1: Claude CLI (구독 사용)
  if (_claudePath) {
    try {
      result = await new Promise((resolve) => {
        const args = ['-p', prompt, '--output-format', 'json', imagePath];
        execFile(_claudePath, args, { timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
          if (err) { console.warn('[vision-analyzer] CLI 실패:', err.message); resolve(null); return; }
          try {
            const out = JSON.parse(stdout);
            const text = out.result || out.content?.[0]?.text || stdout;
            const jsonMatch = String(text).match(/\{[\s\S]*\}/);
            resolve(jsonMatch ? JSON.parse(jsonMatch[0]) : null);
          } catch {
            // JSON 파싱 실패 — 텍스트에서 추출 시도
            const jsonMatch = stdout.match(/\{[\s\S]*\}/);
            resolve(jsonMatch ? JSON.parse(jsonMatch[0]) : { description: stdout.slice(0, 100), activity: 'unknown', app: context.app || 'unknown', confidence: 0.3 });
          }
        });
      });
    } catch {}
  }

  // 방법 2: API 키 폴백
  if (!result) {
    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (apiKey) {
      const https = require('https');
      const imageData = fs.readFileSync(imagePath);
      const base64 = imageData.toString('base64');
      const body = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
          { type: 'text', text: prompt }
        ]}]
      });

      result = await new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) },
        }, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const text = parsed.content?.[0]?.text || '';
              const m = text.match(/\{[\s\S]*\}/);
              resolve(m ? JSON.parse(m[0]) : null);
            } catch { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(30000, () => { req.destroy(); resolve(null); });
        req.write(body); req.end();
      });
    }
  }

  // 캐시 저장
  if (result) {
    _analysisCache.set(cKey, { result, ts: Date.now() });
    // 캐시 크기 제한 (100개)
    if (_analysisCache.size > 100) {
      const oldest = [..._analysisCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) _analysisCache.delete(oldest[0]);
    }
  }

  return result;
}

/**
 * 두 스크린샷 비교 분석 — 뭐가 변경됐는지
 * @param {string} beforePath - 이전 캡처
 * @param {string} afterPath - 현재 캡처
 * @param {Object} context
 * @returns {Promise<{changes: string, changeType: string, details: string}>}
 */
async function analyzeChanges(beforePath, afterPath, context = {}) {
  if (!_claudePath) _claudePath = findClaudeCli();
  if (!_claudePath) return null;
  if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) return null;

  const prompt = `두 스크린샷을 비교해주세요. 첫 번째는 이전 상태, 두 번째는 현재 상태입니다.
앱: ${context.app || '알 수 없음'}
윈도우: ${context.windowTitle || '알 수 없음'}

JSON으로 답변:
{
  "changes": "무엇이 변경되었는지 1줄 요약 (예: A3셀에 VLOOKUP 수식 입력, 3번 슬라이드에 차트 추가)",
  "changeType": "데이터입력/수식작성/서식변경/차트생성/문서편집/탭전환/메뉴조작/기타",
  "details": "변경 내용 상세 2~3줄 (셀 주소, 입력값, 메뉴 경로 등 구체적으로)",
  "dataFlow": "데이터가 어디서 어디로 이동했는지 (예: 웹→엑셀 A열, 없으면 빈문자열)",
  "automatable": true/false,
  "automatableReason": "자동화 가능하다면 이유 (예: 같은 패턴의 VLOOKUP 반복)"
}`;

  try {
    return await new Promise((resolve) => {
      const args = ['-p', prompt, '--output-format', 'json', beforePath, afterPath];
      execFile(_claudePath, args, { timeout: 90000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
        if (err) { resolve(null); return; }
        try {
          const text = String(stdout);
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          resolve(jsonMatch ? JSON.parse(jsonMatch[0]) : null);
        } catch { resolve(null); }
      });
    });
  } catch { return null; }
}

module.exports = { analyzeScreenshot, analyzeChanges, getApiKey, findClaudeCli };
