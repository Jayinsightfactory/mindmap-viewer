'use strict';
/**
 * server-vision-worker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Railway 서버에서 직접 Claude Vision API 호출
 * 맥미니 없이 화면 캡처 → 업무 분석 처리
 *
 * 분석 내용:
 *   - 화면에서 어떤 업무를 하고 있는지 (Excel/카카오/ERP/크롬 등)
 *   - 카카오톡: 대화 패턴 분석 (주문접수/확인/문의/결제 패턴)
 *   - 클릭 좌표 + 화면 결합 → "어느 셀/버튼을 눌렀는지"
 *   - 반복 패턴 감지 → 자동화 가능 업무 식별
 *
 * 환경변수: ANTHROPIC_API_KEY (Railway Variables에서 설정)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https = require('https');
const http  = require('http');

const API_KEY   = process.env.ANTHROPIC_API_KEY || '';
const MODEL     = 'claude-haiku-4-5-20251001';   // 빠르고 저렴한 Vision 모델
const MAX_TOKENS = 600;

// 분석 간격 (큐에 이미지가 쌓이면 N초마다 1건씩 처리)
const PROCESS_INTERVAL_MS = 8000;   // 8초마다 1건 (API 레이트 리밋 방지)

let _timer    = null;
let _running  = false;
let _insertFn = null;  // DB insertEvent 함수 (server.js에서 주입)

// ── 앱별 분석 프롬프트 ─────────────────────────────────────────────────────

function _buildPrompt(ev) {
  const app   = (ev.app || '').toLowerCase();
  const title = ev.windowTitle || '';
  const clicks = ev.recentClicks || [];  // [{x,y,app,ts}] 직전 클릭들

  const clickDesc = clicks.length
    ? `\n직전 마우스 클릭 좌표: ${clicks.map(c => `(${c.x},${c.y})`).join(' → ')}`
    : '';

  // 카카오톡 전용 프롬프트 (대화 패턴에 집중)
  if (app.includes('kakao') || title.includes('카카오')) {
    return `이 카카오톡 화면을 분석해주세요.${clickDesc}

JSON으로 답변 (한국어):
{
  "app": "KakaoTalk",
  "chatRoom": "대화방 이름 (보이면)",
  "messagePattern": "대화 패턴 유형 — 주문접수/주문확인/배송문의/결제/클레임/일반업무/기타 중 하나",
  "lastMessages": "화면에 보이는 마지막 메시지 2~3개 요약 (발신자명 제외, 내용 패턴만)",
  "workKeywords": ["화면에 보이는 업무 키워드 (예: 수량, 발주, 거래처, 날짜 등)"],
  "actionRequired": "이 대화에서 사용자가 해야 할 다음 행동 (예: 발주서 확인, 수량 답변)",
  "automatable": true/false,
  "automatableReason": "자동화 가능하면 이유 (예: 주문 확인 메시지 패턴 반복됨)"
}`;
  }

  // Excel / 스프레드시트
  if (app.includes('excel') || app.includes('sheets') || title.match(/\.xlsx|\.csv|스프레드시트/i)) {
    return `이 Excel/스프레드시트 화면을 분석해주세요.${clickDesc}

JSON으로 답변 (한국어):
{
  "app": "Excel",
  "sheetName": "시트명 (보이면)",
  "taskType": "작업 유형 — 데이터입력/수식작성/피벗/필터링/서식/차트/복사붙여넣기/기타",
  "description": "지금 정확히 뭘 하고 있는지 1줄 (예: B열에 거래처명 입력, C열 VLOOKUP으로 단가 매칭)",
  "cellArea": "작업 중인 셀 영역 (예: B5:D20)",
  "dataContext": "데이터 내용 파악 (예: 3월 발주서, 거래처별 매출, 재고현황)",
  "clickMapping": "클릭 좌표가 화면의 어느 요소인지 (예: D5셀, 필터버튼, 피벗영역)",
  "automatable": true/false,
  "automatableReason": "자동화 가능하면 이유 (예: 같은 VLOOKUP 패턴 반복, 매일 같은 형식)"
}`;
  }

  // 크롬/엣지 (웹)
  if (app.includes('chrome') || app.includes('msedge') || app.includes('firefox')) {
    return `이 웹브라우저 화면을 분석해주세요.${clickDesc}
(주의: 인터넷뱅킹/금융 화면이면 "bankingScreen":true 만 반환하고 내용 분석 불필요)

JSON으로 답변 (한국어):
{
  "app": "Browser",
  "bankingScreen": false,
  "siteName": "사이트명 또는 서비스명",
  "taskType": "웹업무 유형 — ERP조회/발주/결제/이메일/검색/영상/기타",
  "description": "지금 하는 업무 1줄",
  "workKeywords": ["화면에 보이는 업무 관련 키워드"],
  "automatable": false,
  "automatableReason": ""
}`;
  }

  // ERP / 업무 시스템
  if (title.match(/ERP|MES|WMS|SCM|그룹웨어|전자결재|인사|회계|재무|세금계산서/i)) {
    return `이 업무 시스템 화면을 분석해주세요.${clickDesc}

JSON으로 답변 (한국어):
{
  "app": "${ev.app || 'ERP'}",
  "systemType": "시스템 유형 (ERP/MES/WMS/그룹웨어/기타)",
  "menuPath": "현재 메뉴/화면명 (보이면)",
  "taskType": "작업 유형 — 조회/입력/결재/승인/출력/기타",
  "description": "정확히 어떤 업무 화면인지 (예: 발주서 조회, 거래처 매출 조회, 전자결재 승인)",
  "dataVisible": "화면에 보이는 주요 데이터 (예: 거래처명, 금액, 날짜)",
  "automatable": true/false,
  "automatableReason": ""
}`;
  }

  // 기본 (모든 앱)
  return `이 화면을 분석해주세요.
앱: ${ev.app || '알 수 없음'}
창 제목: ${title || '알 수 없음'}${clickDesc}

JSON으로 답변 (한국어):
{
  "app": "${ev.app || ''}",
  "taskType": "작업유형 — 문서작성/스프레드시트/커뮤니케이션/웹검색/ERP/디자인/개발/기타",
  "description": "지금 정확히 뭘 하고 있는지 1줄 (구체적으로)",
  "details": "화면에 보이는 주요 내용 2줄",
  "workIntensity": "high/medium/low (작업 집중도)",
  "automatable": true/false,
  "automatableReason": "자동화 가능하다면 이유"
}`;
}

// ── Claude Vision API 호출 ──────────────────────────────────────────────────

function _callVisionApi(base64Image, prompt) {
  return new Promise((resolve) => {
    if (!API_KEY) { resolve(null); return; }

    const body = JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Image } },
          { type: 'text',  text: prompt },
        ],
      }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) { console.warn('[vision-worker] API 오류:', parsed.error.message); resolve(null); return; }
          const text = parsed.content?.[0]?.text || '';
          const m    = text.match(/\{[\s\S]*\}/);
          resolve(m ? JSON.parse(m[0]) : { description: text.slice(0, 200), taskType: 'unknown' });
        } catch (e) { console.warn('[vision-worker] 파싱 오류:', e.message); resolve(null); }
      });
    });
    req.on('error', (e) => { console.warn('[vision-worker] 요청 오류:', e.message); resolve(null); });
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── 큐 1건 처리 ────────────────────────────────────────────────────────────

async function _processOne() {
  const queue = global._visionImageQueue;
  if (!queue || queue.length === 0) return;

  const item = queue.shift();  // FIFO
  if (!item?.imageBase64) return;

  try {
    console.log(`[vision-worker] 분석 시작: ${item.hostname}/${item.app} (큐 남은: ${queue.length}건)`);

    const prompt = _buildPrompt({
      app:          item.app,
      windowTitle:  item.windowTitle,
      recentClicks: item.recentClicks || [],
    });

    const result = await _callVisionApi(item.imageBase64, prompt);
    if (!result) return;

    // bankingScreen이면 저장 안 함
    if (result.bankingScreen) {
      console.log('[vision-worker] 금융 화면 감지 — 저장 스킵');
      return;
    }

    console.log(`[vision-worker] 분석 완료: ${result.taskType} — ${(result.description || '').slice(0, 60)}`);

    // DB에 vision.analysis 이벤트 저장
    if (_insertFn) {
      await Promise.resolve(_insertFn({
        id:        'vision-' + Date.now(),
        type:      'vision.analysis',
        source:    'server-vision-worker',
        sessionId: 'daemon-' + item.hostname,
        timestamp: item.ts || new Date().toISOString(),
        userId:    item.userId || 'local',
        data: {
          hostname:    item.hostname,
          app:         item.app,
          windowTitle: item.windowTitle,
          trigger:     item.trigger,
          bankMode:    item.bankMode || false,
          // 분석 결과
          ...result,
        },
      }));
    }

  } catch (err) {
    console.error('[vision-worker] 처리 오류:', err.message);
  }
}

// ── 공개 API ────────────────────────────────────────────────────────────────

/**
 * 워커 시작
 * @param {Function} insertEventFn — server.js의 insertEvent 함수
 */
function start(insertEventFn) {
  if (_running) return;
  if (!API_KEY) {
    console.warn('[vision-worker] ANTHROPIC_API_KEY 없음 — Vision 분석 비활성화');
    console.warn('[vision-worker] Railway Variables에서 ANTHROPIC_API_KEY 설정 필요');
    return;
  }

  _insertFn = insertEventFn;
  _running  = true;
  _timer    = setInterval(_processOne, PROCESS_INTERVAL_MS);
  console.log(`[vision-worker] 시작 — ${PROCESS_INTERVAL_MS/1000}초마다 큐 처리 (모델: ${MODEL})`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _running = false;
}

function isRunning() { return _running; }

module.exports = { start, stop, isRunning };
