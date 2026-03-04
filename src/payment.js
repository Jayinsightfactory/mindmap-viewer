/**
 * payment.js
 * PG 연동 구조 — 토스페이먼츠
 *
 * ⚠️  실제 운영하려면:
 *   1. https://developers.tosspayments.com 에서 API 키 발급
 *   2. TOSS_CLIENT_KEY, TOSS_SECRET_KEY 환경변수 설정
 *   3. 월 기본료 없음, 거래 수수료만 (카드 2.2~3.3%, 계좌 1.0%)
 *
 * 현재는 목(Mock) 모드로 동작 — 실제 요금 청구 없음
 */
const https = require('https');

const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || '';
const MOCK_MODE       = !TOSS_SECRET_KEY;

// ─── 플랜 정의 ────────────────────────────────────
const PLANS = {
  free: {
    id: 'free', name: 'Free',
    price: 0, currency: 'KRW',
    features: ['개인 추적', '기본 마인드맵', '테마 무료 다운로드'],
    limits: { channels: 1, events: 10000, members: 1 },
  },
  pro: {
    id: 'pro', name: 'Pro',
    price: 9900, currency: 'KRW',
    features: ['팀 대시보드', '감사 로그', 'Shadow AI 감지', '컨텍스트 브릿지', '테마 판매'],
    limits: { channels: 5, events: -1, members: 10 },
  },
  team: {
    id: 'team', name: 'Team',
    price: 29900, currency: 'KRW',
    features: ['무제한 채널', '무제한 멤버', 'PR 자동 태그', 'PDF 감사 리포트', '전용 지원'],
    limits: { channels: -1, events: -1, members: -1 },
  },
};

// ─── 결제 요청 생성 ───────────────────────────────
async function createPayment({ planId, userId, userEmail, orderId }) {
  const plan = PLANS[planId];
  if (!plan || plan.price === 0) return { error: 'invalid plan or free plan' };

  if (MOCK_MODE) {
    return {
      mock: true,
      orderId:     orderId || 'mock-' + Date.now(),
      amount:      plan.price,
      planId,
      clientKey:   'test_ck_mock',
      customerKey: userId,
      orderName:   `Orbit ${plan.name} 월정액`,
    };
  }

  return {
    clientKey:     process.env.TOSS_CLIENT_KEY,
    amount:        plan.price,
    orderId:       orderId || `orbit-${userId}-${Date.now()}`,
    orderName:     `Orbit ${plan.name} 월정액`,
    customerKey:   userId,
    customerEmail: userEmail,
    planId,
  };
}

// ─── 결제 승인 (서버 사이드) ──────────────────────
async function confirmPayment({ paymentKey, orderId, amount }) {
  if (MOCK_MODE) {
    return {
      mock: true,
      paymentKey,
      orderId,
      amount,
      status: 'DONE',
      approvedAt: new Date().toISOString(),
    };
  }

  const auth = Buffer.from(TOSS_SECRET_KEY + ':').toString('base64');
  const body = JSON.stringify({ paymentKey, orderId, amount });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.tosspayments.com',
      path:     '/v1/payments/confirm',
      method:   'POST',
      headers: {
        'Authorization':  `Basic ${auth}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error('parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy());
    req.write(body);
    req.end();
  });
}

// ─── 구독 취소 ───────────────────────────────────
async function cancelSubscription({ billingKey, cancelReason }) {
  if (MOCK_MODE) return { mock: true, status: 'CANCELED' };

  const auth = Buffer.from(TOSS_SECRET_KEY + ':').toString('base64');
  const body = JSON.stringify({ cancelReason: cancelReason || '사용자 요청' });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.tosspayments.com',
      path:     `/v1/billing/${billingKey}/cancel`,
      method:   'POST',
      headers: {
        'Authorization':  `Basic ${auth}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error('parse error')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { PLANS, createPayment, confirmPayment, cancelSubscription, MOCK_MODE };
