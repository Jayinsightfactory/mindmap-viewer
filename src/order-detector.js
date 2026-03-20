'use strict';
/**
 * order-detector.js — 카카오톡 주문 자동 감지 + 정리
 *
 * 클립보드에서 복사된 텍스트가 주문 패턴(품종/수량)이면
 * 자동으로 정리해서 이벤트로 전송.
 * nenova ERP에 붙여넣기 가능한 형태로 변환.
 *
 * 알고리즘 A: 카카오톡 → 복사 → 자동 감지 → 정리 → nenova 입력 보조
 */

const os = require('os');

// 주문 패턴 (꽃 관련 키워드 + 수량)
const ORDER_PATTERNS = [
  // "카네이션 100" / "장미 50본" / "국화 30단"
  /([가-힣a-zA-Z]+)\s*[:\-]?\s*(\d+)\s*(본|단|속|박스|개|송이|set)?/g,
  // "100 카네이션" (수량 먼저)
  /(\d+)\s*(본|단|속|박스|개|송이|set)?\s*([가-힣a-zA-Z]+)/g,
];

// 꽃/식물 관련 키워드 (nenova 연관)
const FLOWER_KEYWORDS = [
  '카네이션', '장미', '국화', '백합', '튤립', '해바라기', '안개꽃',
  '거베라', '수국', '프리지아', '리시안', '스톡', '델피늄', '알스트로',
  '아이리스', '카라', '소국', '대국', '레몬리프', '유칼립투스',
  '스프레이', '미니장미', '엘레강스', '네오셀', '리모늄',
  // nenova 제품 관련
  'CARNATION', 'ROSE', '발주', '주문', '출고', '수입', '매출',
];

let _callback = null;
let _lastOrderTs = 0;

function init(onOrderDetected) {
  _callback = onOrderDetected;
  console.log('[order-detector] 주문 패턴 감지 초기화');
}

/**
 * 클립보드 텍스트에서 주문 패턴 감지
 */
function analyzeClipboard(clipEvent) {
  if (!_callback) return null;
  const text = clipEvent.text || '';
  if (!text || text.length < 5 || text.length > 2000) return null;

  // 쿨다운 (같은 텍스트 5초 이내 중복 방지)
  const now = Date.now();
  if (now - _lastOrderTs < 5000) return null;

  // 카카오톡에서 복사된 것인지 확인
  const fromKakao = (clipEvent.sourceApp || '').toLowerCase().includes('kakaotalk') ||
                    (clipEvent.sourceApp || '').toLowerCase().includes('kakao');

  // 주문 관련 키워드 포함 여부
  const hasFlowerKeyword = FLOWER_KEYWORDS.some(kw =>
    text.toUpperCase().includes(kw.toUpperCase())
  );

  // 숫자 포함 여부 (수량)
  const hasNumbers = /\d{1,5}/.test(text);

  // 주문으로 판단되는 조건:
  // 1) 카카오톡에서 복사 + 숫자 포함
  // 2) 꽃 키워드 + 숫자 포함
  if (!(fromKakao && hasNumbers) && !(hasFlowerKeyword && hasNumbers)) return null;

  // 주문 항목 추출
  const items = extractOrderItems(text);
  if (items.length === 0) return null;

  _lastOrderTs = now;

  const orderData = {
    type: 'order.detected',
    source: fromKakao ? 'kakaotalk' : 'clipboard',
    rawText: text.substring(0, 500),
    items,
    itemCount: items.length,
    totalQuantity: items.reduce((s, i) => s + (i.quantity || 0), 0),
    hostname: os.hostname(),
    timestamp: new Date().toISOString(),
  };

  console.log(`[order-detector] 주문 감지: ${items.length}건 (총 ${orderData.totalQuantity}개)`);
  items.forEach(i => console.log(`  ${i.name}: ${i.quantity}${i.unit || ''}`));

  _callback(orderData);
  return orderData;
}

function extractOrderItems(text) {
  const items = [];
  const seen = new Set();
  const lines = text.split(/[\n\r]+/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 2) continue;

    // "품종 수량단위" 패턴
    const m1 = trimmed.match(/([가-힣a-zA-Z\s]+?)\s*[:\-]?\s*(\d+)\s*(본|단|속|박스|개|송이|set|SET)?/);
    if (m1) {
      const name = m1[1].trim();
      const qty = parseInt(m1[2]);
      const unit = m1[3] || '';
      if (name.length >= 1 && qty > 0 && !seen.has(name)) {
        seen.add(name);
        items.push({ name, quantity: qty, unit });
      }
    }
  }
  return items;
}

module.exports = { init, analyzeClipboard };
