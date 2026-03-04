/**
 * context-bridge.js
 * Phase 1-B: Context Bridge — 도구 전환 시 맥락 자동 이어받기
 *
 * 문제: Claude → Cursor → n8n 전환 시 맥락이 매번 초기화됨
 * 해결: 마지막 세션의 핵심 맥락을 추출 → 다음 도구에 주입 가능한 형태로 생성
 *
 * 출력 형태:
 *   - CONTEXT.md 파일 (Cursor 자동 로드용)
 *   - context-prompt.txt (다음 AI에 붙여넣기용)
 *   - /api/context/bridge API (프로그래매틱 조회)
 */
const fs   = require('fs');
const path = require('path');

// ─── 맥락 추출 ──────────────────────────────────────
function extractContext(events, opts = {}) {
  const { maxFiles = 10, maxMessages = 5, targetTool = null } = opts;

  if (!events || events.length === 0) return null;

  // 최근 이벤트 기준 (뒤에서부터 분석)
  const recent = [...events].reverse();

  // 수정된 파일 목록 (최근 순)
  const recentFiles = [];
  const seenPaths   = new Set();
  for (const e of recent) {
    const paths = [e.data?.filePath, ...(e.data?.files || [])]
      .filter(f => f && typeof f === 'string' && !f.startsWith('['));
    for (const fp of paths) {
      if (!seenPaths.has(fp)) {
        seenPaths.add(fp);
        recentFiles.push({ path: fp, operation: e.data?.operation || 'accessed', ts: e.timestamp });
        if (recentFiles.length >= maxFiles) break;
      }
    }
    if (recentFiles.length >= maxFiles) break;
  }

  // 최근 사용자 요청 (의도 파악)
  const recentRequests = recent
    .filter(e => e.type === 'user.message')
    .slice(0, maxMessages)
    .map(e => ({ content: (e.data?.content || e.data?.contentPreview || '').substring(0, 300), ts: e.timestamp }))
    .reverse();

  // 최근 오류 (해결해야 할 것)
  const recentErrors = recent
    .filter(e => e.type === 'tool.error')
    .slice(0, 3)
    .map(e => ({ tool: e.data?.toolName, preview: e.data?.inputPreview || '', ts: e.timestamp }));

  // 목적 분포 (무엇을 하고 있는지)
  const purposeCount = {};
  for (const e of events.slice(-50)) {
    const p = e.purposeId;
    if (p) purposeCount[p] = (purposeCount[p] || 0) + 1;
  }
  const topPurpose = Object.entries(purposeCount).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';

  // AI 소스 감지 (어디서 왔는지)
  const sourceSet = new Set(events.slice(-20).map(e => e.source || e.aiSource).filter(Boolean));

  // 최근 어시스턴트 응답 요약
  const lastAssistant = recent.find(e => e.type === 'assistant.message');
  const lastSummary = lastAssistant
    ? (lastAssistant.data?.content || lastAssistant.data?.contentPreview || '').substring(0, 500)
    : null;

  return {
    extractedAt:    new Date().toISOString(),
    targetTool,
    topPurpose,
    activeSources:  [...sourceSet],
    recentFiles,
    recentRequests,
    recentErrors,
    lastSummary,
    totalEvents:    events.length,
  };
}

// ─── Context → CONTEXT.md (Cursor/.cursorrules 자동 로드용) ──
function renderContextMd(ctx, opts = {}) {
  if (!ctx) return '';
  const { projectName = 'Project' } = opts;

  const fileList = ctx.recentFiles
    .map(f => `- \`${f.path}\` (${f.operation})`)
    .join('\n');

  const requestList = ctx.recentRequests
    .map((r, i) => `${i + 1}. ${r.content}`)
    .join('\n');

  const errorList = ctx.recentErrors.length > 0
    ? ctx.recentErrors.map(e => `- [${e.tool}] ${e.preview.substring(0, 80)}`).join('\n')
    : '없음';

  const PURPOSE_LABELS = {
    implement: '기능 구현', fix: '버그 수정', refactor: '코드 정리',
    test: '테스트', deploy: '배포', research: '조사', config: '설정',
  };

  return `# Orbit Context Bridge
> 자동 생성됨: ${new Date(ctx.extractedAt).toLocaleString('ko-KR')}
> 이전 도구: ${ctx.activeSources.join(', ')} → 현재 도구: ${ctx.targetTool || '미지정'}

## 현재 작업 맥락

**주요 목적:** ${PURPOSE_LABELS[ctx.topPurpose] || ctx.topPurpose}
**총 이벤트:** ${ctx.totalEvents}개

## 최근 수정/접근 파일
${fileList || '없음'}

## 최근 사용자 요청
${requestList || '없음'}

## 미해결 오류
${errorList}

## 이전 AI 응답 요약
${ctx.lastSummary ? ctx.lastSummary.substring(0, 400) + (ctx.lastSummary.length > 400 ? '...' : '') : '없음'}

---
*위 내용은 Orbit이 자동으로 수집한 작업 맥락입니다.*
*다음 AI 도구에 이 파일을 컨텍스트로 제공하면 작업을 이어받을 수 있습니다.*`;
}

// ─── Context → 바로 붙여넣기용 프롬프트 ────────────
function renderContextPrompt(ctx, opts = {}) {
  if (!ctx) return '';
  const { targetTool = 'AI' } = opts;

  const files = ctx.recentFiles.slice(0, 5).map(f => f.path).join(', ');
  const lastRequest = ctx.recentRequests[ctx.recentRequests.length - 1]?.content || '';

  return `[Orbit Context Bridge — 이전 세션 맥락]
작업 목적: ${ctx.topPurpose}
최근 수정 파일: ${files || '없음'}
마지막 요청: "${lastRequest}"
${ctx.recentErrors.length > 0 ? `미해결 오류: ${ctx.recentErrors[0]?.preview?.substring(0, 100)}` : ''}

위 맥락을 이어서 작업해주세요.`;
}

// ─── CONTEXT.md 파일 저장 ───────────────────────────
function saveContextFile(ctx, targetDir) {
  if (!ctx || !targetDir) return null;
  const content  = renderContextMd(ctx);
  const filePath = path.join(targetDir, 'ORBIT_CONTEXT.md');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

module.exports = { extractContext, renderContextMd, renderContextPrompt, saveContextFile };
