/**
 * payment.js
 * PG 연동 구조 — Stripe
 *
 * ⚠️  실제 운영하려면:
 *   1. https://dashboard.stripe.com 에서 API 키 발급
 *   2. STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET 환경변수 설정
 *   3. Stripe 수수료: 카드 2.9% + $0.30 / 건
 *
 * 현재는 목(Mock) 모드로 동작 — STRIPE_SECRET_KEY 미설정 시 실제 요금 청구 없음
 */

'use strict';

// ─── Stripe SDK 조건부 로드 ──────────────────────────
let stripe = null;
try {
  const Stripe = require('stripe');
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  }
} catch {
  // stripe 패키지 미설치 — Mock 모드로 동작
}

const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET || '';
const MOCK_MODE              = !STRIPE_SECRET_KEY || !stripe;

// ─── 플랜 정의 (USD 기준) ────────────────────────────
const PLANS = {
  free: {
    id: 'free', name: 'Free', badge: '',
    price: 0, priceLabel: '$0', period: '',
    currency: 'USD',
    description: 'Free plan for individual developers',
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
    price: 1900, priceLabel: '$19', period: '/mo',
    currency: 'USD',
    description: 'Pro plan for power users',
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
      'AI 모니터 (PIP/타일/도킹)',
      '이메일 지원',
    ],
    limits: { channels: 5, events: -1, members: 10, sessions: -1, aiQueries: 500 },
    cta: 'Start Pro',
    popular: true,
  },
  team: {
    id: 'team', name: 'Team', badge: '',
    price: 4900, priceLabel: '$49', period: '/user/mo',
    currency: 'USD',
    description: 'Team plan for collaboration',
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
      '성장 엔진 (레벨/뱃지)',
      '우선 지원 (SLA 24h)',
    ],
    limits: { channels: -1, events: -1, members: -1, sessions: -1, aiQueries: 2000 },
    cta: 'Start Team',
    popular: false,
  },
  enterprise: {
    id: 'enterprise', name: 'Enterprise', badge: '',
    price: -1, priceLabel: 'Contact Us', period: '',
    currency: 'USD',
    description: 'Enterprise plan for large organizations',
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
    cta: 'Contact Sales',
    popular: false,
  },
};

// ─── 플랜 ID → Stripe Price ID 매핑 (대시보드에서 생성 후 설정) ───
const STRIPE_PRICE_IDS = {
  pro:  process.env.STRIPE_PRICE_PRO  || 'price_pro_placeholder',
  team: process.env.STRIPE_PRICE_TEAM || 'price_team_placeholder',
};

// ─── 플랜 순서 (게이팅용) ────────────────────────────
const PLAN_ORDER = ['free', 'pro', 'team', 'enterprise'];

// ─── Stripe Checkout Session 생성 ────────────────────
/**
 * Stripe Checkout Session을 생성합니다.
 * 사용자를 Stripe 호스팅 결제 페이지로 리다이렉트하기 위한 세션 URL을 반환합니다.
 *
 * @param {object} params
 * @param {string} params.planId      - 플랜 ID ('pro' | 'team')
 * @param {string} params.userId      - 사용자 ID
 * @param {string} params.userEmail   - 사용자 이메일
 * @param {string} params.successUrl  - 결제 성공 후 리다이렉트 URL
 * @param {string} params.cancelUrl   - 결제 취소 시 리다이렉트 URL
 * @returns {Promise<object>} 세션 정보 (id, url 포함)
 */
async function createCheckoutSession({ planId, userId, userEmail, successUrl, cancelUrl }) {
  const plan = PLANS[planId];
  if (!plan || plan.price <= 0) return { error: 'invalid_plan', message: '유효하지 않은 플랜이거나 결제가 필요 없는 플랜입니다.' };

  if (MOCK_MODE) {
    const mockSessionId = 'cs_mock_' + Date.now();
    return {
      mock: true,
      id: mockSessionId,
      url: `${successUrl}?session_id=${mockSessionId}&plan=${planId}`,
      planId,
      amount: plan.price,
      currency: 'usd',
      customerEmail: userEmail,
    };
  }

  // Stripe Checkout Session 생성
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: userEmail,
    line_items: [{
      price: STRIPE_PRICE_IDS[planId],
      quantity: 1,
    }],
    metadata: {
      userId,
      planId,
    },
    success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl,
  });

  return {
    id:  session.id,
    url: session.url,
    planId,
    amount: plan.price,
    currency: 'usd',
  };
}

// ─── 결제 확인 (세션 조회) ───────────────────────────
/**
 * Stripe Checkout Session을 조회하여 결제 상태를 확인합니다.
 *
 * @param {object} params
 * @param {string} params.sessionId - Stripe Checkout Session ID
 * @returns {Promise<object>} 세션 상태 정보
 */
async function confirmPayment({ sessionId }) {
  if (MOCK_MODE) {
    return {
      mock: true,
      id: sessionId,
      payment_status: 'paid',
      status: 'complete',
      customer: 'cus_mock_' + Date.now(),
      subscription: 'sub_mock_' + Date.now(),
      metadata: { planId: 'pro', userId: 'mock-user' },
      confirmedAt: new Date().toISOString(),
    };
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  return {
    id:             session.id,
    payment_status: session.payment_status,
    status:         session.status,
    customer:       session.customer,
    subscription:   session.subscription,
    metadata:       session.metadata,
  };
}

// ─── 구독 취소 ───────────────────────────────────────
/**
 * Stripe 구독을 취소합니다.
 * 즉시 취소가 아닌, 현재 결제 기간 종료 시 취소됩니다 (cancel_at_period_end).
 *
 * @param {object} params
 * @param {string} params.subscriptionId - Stripe Subscription ID
 * @returns {Promise<object>} 취소된 구독 정보
 */
async function cancelSubscription({ subscriptionId }) {
  if (MOCK_MODE) {
    return {
      mock: true,
      id: subscriptionId || 'sub_mock_canceled',
      status: 'canceled',
      cancel_at_period_end: true,
      canceled_at: new Date().toISOString(),
    };
  }

  const subscription = await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });

  return {
    id:                   subscription.id,
    status:               subscription.status,
    cancel_at_period_end: subscription.cancel_at_period_end,
    canceled_at:          new Date().toISOString(),
  };
}

// ─── Customer Portal 세션 생성 ───────────────────────
/**
 * Stripe Customer Portal 세션을 생성합니다.
 * 사용자가 스스로 결제 수단 변경, 구독 관리, 청구서 확인을 할 수 있습니다.
 *
 * @param {object} params
 * @param {string} params.customerId - Stripe Customer ID
 * @returns {Promise<object>} 포털 세션 정보 (url 포함)
 */
async function createCustomerPortalSession({ customerId }) {
  if (MOCK_MODE) {
    return {
      mock: true,
      url: '/orbit3d.html?portal=mock',
      customerId,
    };
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: process.env.CLIENT_ORIGIN || 'http://localhost:4747/orbit3d.html',
  });

  return {
    url: session.url,
    customerId,
  };
}

// ─── Webhook 이벤트 처리 ─────────────────────────────
/**
 * Stripe Webhook 이벤트를 처리합니다.
 * 결제 성공, 구독 갱신, 구독 취소 등의 이벤트를 수신합니다.
 *
 * @param {object} event - Stripe Event 객체
 * @returns {{ type: string, data: object }} 처리 결과
 */
function handleWebhookEvent(event) {
  const { type, data } = event;

  switch (type) {
    // 결제 성공 (Checkout 완료)
    case 'checkout.session.completed': {
      const session = data.object;
      return {
        type: 'checkout_completed',
        data: {
          sessionId:      session.id,
          customerId:     session.customer,
          subscriptionId: session.subscription,
          userId:         session.metadata?.userId,
          planId:         session.metadata?.planId,
          paymentStatus:  session.payment_status,
        },
      };
    }

    // 구독 갱신 성공
    case 'invoice.payment_succeeded': {
      const invoice = data.object;
      return {
        type: 'payment_succeeded',
        data: {
          customerId:     invoice.customer,
          subscriptionId: invoice.subscription,
          amountPaid:     invoice.amount_paid,
          currency:       invoice.currency,
        },
      };
    }

    // 구독 결제 실패 (카드 만료 등)
    case 'invoice.payment_failed': {
      const invoice = data.object;
      return {
        type: 'payment_failed',
        data: {
          customerId:     invoice.customer,
          subscriptionId: invoice.subscription,
          attemptCount:   invoice.attempt_count,
        },
      };
    }

    // 구독 취소됨
    case 'customer.subscription.deleted': {
      const subscription = data.object;
      return {
        type: 'subscription_canceled',
        data: {
          customerId:     subscription.customer,
          subscriptionId: subscription.id,
          canceledAt:     subscription.canceled_at,
        },
      };
    }

    // 구독 상태 변경 (업그레이드/다운그레이드 포함)
    case 'customer.subscription.updated': {
      const subscription = data.object;
      return {
        type: 'subscription_updated',
        data: {
          customerId:         subscription.customer,
          subscriptionId:     subscription.id,
          status:             subscription.status,
          cancelAtPeriodEnd:  subscription.cancel_at_period_end,
        },
      };
    }

    default:
      return { type: 'unhandled', data: { eventType: type } };
  }
}

// ─── 구독 상태 조회 ──────────────────────────────────
/**
 * Stripe Customer의 현재 구독 상태를 조회합니다.
 *
 * @param {string} customerId - Stripe Customer ID
 * @returns {Promise<object|null>} 활성 구독 정보 또는 null
 */
async function getSubscriptionStatus(customerId) {
  if (MOCK_MODE) {
    return {
      mock: true,
      customerId,
      status: 'active',
      planId: 'pro',
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'active',
    limit: 1,
  });

  if (subscriptions.data.length === 0) return null;

  const sub = subscriptions.data[0];
  return {
    customerId,
    subscriptionId:   sub.id,
    status:           sub.status,
    priceId:          sub.items.data[0]?.price?.id,
    currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  };
}

// ─── 플랜별 기능 게이팅 미들웨어 ─────────────────────
/**
 * 최소 플랜 등급을 요구하는 Express 미들웨어입니다.
 * 사용자의 현재 플랜이 요구 등급 미만이면 403 응답을 반환합니다.
 *
 * @param {string} minPlan - 최소 요구 플랜 ('pro' | 'team' | 'enterprise')
 * @returns {function} Express 미들웨어
 */
function requirePlan(minPlan) {
  return (req, res, next) => {
    const userPlan = req.user?.plan || 'free';
    const userIdx  = PLAN_ORDER.indexOf(userPlan);
    const minIdx   = PLAN_ORDER.indexOf(minPlan);

    if (userIdx >= minIdx) return next();

    res.status(403).json({
      error: 'upgrade_required',
      requiredPlan: minPlan,
      currentPlan:  userPlan,
      message: `이 기능을 사용하려면 ${PLANS[minPlan]?.name || minPlan} 플랜 이상이 필요합니다.`,
    });
  };
}

// ─── Stripe Webhook 서명 검증 ────────────────────────
/**
 * Stripe Webhook 서명을 검증합니다.
 *
 * @param {Buffer} rawBody   - 요청 원본 바디 (Buffer)
 * @param {string} signature - Stripe-Signature 헤더 값
 * @returns {object|null} 검증된 이벤트 객체 또는 null
 */
function verifyWebhookSignature(rawBody, signature) {
  if (MOCK_MODE || !STRIPE_WEBHOOK_SECRET) return null;

  try {
    return stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Stripe] Webhook 서명 검증 실패:', err.message);
    return null;
  }
}

module.exports = {
  PLANS,
  MOCK_MODE,
  STRIPE_PUBLISHABLE_KEY,
  createCheckoutSession,
  confirmPayment,
  cancelSubscription,
  createCustomerPortalSession,
  handleWebhookEvent,
  getSubscriptionStatus,
  requirePlan,
  verifyWebhookSignature,
};
