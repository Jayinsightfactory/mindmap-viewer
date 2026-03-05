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

// ─── 플랜 정의 (Claude Code 스타일) ──────────────
const PLANS = {
  free: {
    id: 'free', name: 'Free', badge: '',
    price: 0, priceLabel: '₩0', period: '',
    currency: 'KRW',
    description: '개인 개발자를 위한 무료 플랜',
    features: [
      '개인 작업 추적',
      '기본 3D 마인드맵',
      '5개 세션 히스토리',
      '기본 이펙트 2개',
      '커뮤니티 지원',
    ],
    limits: { channels: 1, events: 10000, members: 1, sessions: 5, aiQueries: 0 },
    cta: '현재 플랜',
    popular: false,
  },
  pro: {
    id: 'pro', name: 'Pro', badge: 'POPULAR',
    price: 9900, priceLabel: '₩9,900', period: '/월',
    currency: 'KRW',
    description: '파워 유저를 위한 프로 플랜',
    features: [
      'Free의 모든 기능',
      '무제한 세션 히스토리',
      '팀 대시보드 (10명)',
      'AI 인사이트 분석',
      'Shadow AI 감지',
      '감사 로그',
      '컨텍스트 브릿지',
      '모든 이펙트 + 스킨',
      '테마 마켓 판매 가능',
      '이메일 지원',
    ],
    limits: { channels: 5, events: -1, members: 10, sessions: -1, aiQueries: 500 },
    cta: '프로 시작하기',
    popular: true,
  },
  team: {
    id: 'team', name: 'Team', badge: '',
    price: 29900, priceLabel: '₩29,900', period: '/월/멤버',
    currency: 'KRW',
    description: '팀 협업을 위한 비즈니스 플랜',
    features: [
      'Pro의 모든 기능',
      '무제한 채널 & 멤버',
      '실시간 팀 협업',
      '부서별 대시보드',
      '관리자 뷰 & 권한 설정',
      'PR 자동 태그',
      'PDF 감사 리포트',
      '작업 충돌 감지',
      '팀 인사이트 분석',
      '우선 지원 (SLA 24h)',
    ],
    limits: { channels: -1, events: -1, members: -1, sessions: -1, aiQueries: 2000 },
    cta: '팀 시작하기',
    popular: false,
  },
  enterprise: {
    id: 'enterprise', name: 'Enterprise', badge: '',
    price: -1, priceLabel: '문의', period: '',
    currency: 'KRW',
    description: '대규모 조직을 위한 엔터프라이즈',
    features: [
      'Team의 모든 기능',
      '온프레미스 배포 지원',
      'SSO / SAML 인증',
      '커스텀 AI 모델 연동',
      '전용 인프라 격리',
      'SLA 99.9% 보장',
      '전담 매니저 배정',
      'API 무제한 호출',
      '보안 감사 인증서',
      '맞춤 교육 & 온보딩',
    ],
    limits: { channels: -1, events: -1, members: -1, sessions: -1, aiQueries: -1 },
    cta: '영업팀 문의',
    popular: false,
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
