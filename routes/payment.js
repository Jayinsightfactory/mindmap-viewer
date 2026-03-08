/**
 * routes/payment.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 결제/구독 플랜 API 라우터 (Stripe PG 연동)
 *
 * 담당 엔드포인트:
 *   GET  /api/payment/plans    - 구독 플랜 목록 (free/pro/team/enterprise)
 *   POST /api/payment/checkout - Stripe Checkout Session 생성
 *   POST /api/payment/webhook  - Stripe Webhook 수신 (서명 검증)
 *   GET  /api/payment/my-plan  - 현재 사용자 구독 플랜 조회
 *   POST /api/payment/cancel   - 구독 취소 (Free 다운그레이드)
 *   POST /api/payment/portal   - Stripe Customer Portal 세션 생성
 *   GET  /api/payment/success  - Checkout 성공 후 리다이렉트 콜백
 *
 * 환경 변수:
 *   STRIPE_SECRET_KEY 미설정 → MOCK_MODE 활성화 (실제 결제 없음)
 *   STRIPE_SECRET_KEY 설정   → 실제 Stripe API 호출
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();

/**
 * @param {object} deps - 의존성 객체
 * @param {object} deps.payment         - Stripe 결제 모듈 (src/payment.js)
 * @param {function} deps.upgradePlan   - (userId, plan) => boolean — 사용자 플랜 업그레이드
 * @param {function} deps.verifyToken   - (token) => user|null — 토큰 검증
 * @returns {express.Router}
 */
function createRouter(deps) {
  const { payment, upgradePlan, verifyToken } = deps;                            // 의존성 분해
  const {
    PLANS,
    MOCK_MODE: paymentMockMode,
    STRIPE_PUBLISHABLE_KEY,
    createCheckoutSession,
    confirmPayment,
    cancelSubscription,
    createCustomerPortalSession,
    handleWebhookEvent,
    getSubscriptionStatus,
    verifyWebhookSignature,
  } = payment;

  // ── 플랜 목록 ────────────────────────────────────────────────────────────

  /**
   * GET /api/payment/plans
   * 사용 가능한 구독 플랜 목록, MOCK_MODE 여부, Stripe Publishable Key를 반환합니다.
   * 프론트엔드 결제 페이지의 플랜 선택 UI에서 사용합니다.
   *
   * @returns {{ plans: Plan[], mockMode: boolean, stripePublishableKey: string }}
   */
  router.get('/payment/plans', (req, res) => {
    res.json({
      plans: Object.values(PLANS),
      mockMode: paymentMockMode,
      stripePublishableKey: STRIPE_PUBLISHABLE_KEY || '',
    });
  });

  // ── Stripe Checkout Session 생성 ───────────────────────────────────────

  /**
   * POST /api/payment/checkout
   * Stripe Checkout Session을 생성하고 결제 페이지 URL을 반환합니다.
   * MOCK_MODE 에서는 실제 API 호출 없이 테스트용 세션 데이터를 반환합니다.
   *
   * @body {string} planId     - 플랜 ID ('pro' | 'team')
   * @body {string} userId     - 결제 사용자 ID
   * @body {string} userEmail  - 결제 사용자 이메일
   * @body {string} [successUrl] - 결제 성공 후 리다이렉트 URL
   * @body {string} [cancelUrl]  - 결제 취소 시 리다이렉트 URL
   * @returns {{ id: string, url: string, planId: string, amount: number }}
   */
  router.post('/payment/checkout', async (req, res) => {
    // 인증 검증
    const token = (req.headers.authorization || '').replace('Bearer ', '') ||
                  req.headers['x-api-token'] || req.query.token;
    let authUser = null;
    if (token) {
      try { authUser = verifyToken(token); } catch {}
    }

    try {
      const { planId, userEmail, successUrl, cancelUrl } = req.body || {};
      const userId = authUser?.id || req.body?.userId;                           // 인증된 사용자 우선

      const origin = process.env.CLIENT_ORIGIN || `${req.protocol}://${req.get('host')}`;
      const result = await createCheckoutSession({
        planId,
        userId,
        userEmail: userEmail || authUser?.email,
        successUrl:  successUrl || `${origin}/api/payment/success`,
        cancelUrl:   cancelUrl  || `${origin}/orbit3d.html?paymentCancel=true`,
      });

      if (result.error) return res.status(400).json(result);

      // Mock 모드에서 자동 플랜 업그레이드 (테스트 편의)
      if (result.mock && userId && planId && PLANS[planId]) {
        upgradePlan(userId, planId);
      }

      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Stripe Webhook 수신 ────────────────────────────────────────────────

  /**
   * POST /api/payment/webhook
   * Stripe Webhook 이벤트를 수신하고 처리합니다.
   * express.raw() 미들웨어를 통해 원본 바디를 수신해야 합니다.
   * 서명 검증 후 이벤트 타입에 따라 플랜 업그레이드/다운그레이드를 수행합니다.
   *
   * @header {string} stripe-signature - Stripe 서명 헤더
   * @returns {{ received: boolean, type: string }}
   */
  router.post('/payment/webhook', async (req, res) => {
    try {
      let event;

      if (paymentMockMode) {
        // Mock 모드: 서명 검증 없이 바디를 그대로 사용
        event = typeof req.body === 'string' ? JSON.parse(req.body) :
                Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) :
                req.body;
      } else {
        // 프로덕션: Stripe 서명 검증
        const signature = req.headers['stripe-signature'];
        if (!signature) return res.status(400).json({ error: 'stripe-signature 헤더가 필요합니다.' });

        event = verifyWebhookSignature(req.body, signature);
        if (!event) return res.status(400).json({ error: 'Webhook 서명 검증 실패' });
      }

      // 이벤트 처리
      const result = handleWebhookEvent(event);

      // 결제 완료 시 플랜 업그레이드
      if (result.type === 'checkout_completed' && result.data.userId && result.data.planId) {
        upgradePlan(result.data.userId, result.data.planId);
        console.log(`[Stripe] 플랜 업그레이드: ${result.data.userId} → ${result.data.planId}`);
      }

      // 구독 취소 시 Free로 다운그레이드
      if (result.type === 'subscription_canceled' && result.data.customerId) {
        // NOTE: customerId → userId 매핑이 필요 (DB에서 조회)
        console.log(`[Stripe] 구독 취소됨: customer=${result.data.customerId}`);
      }

      res.json({ received: true, type: result.type });
    } catch (e) {
      console.error('[Stripe] Webhook 처리 오류:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── 현재 플랜 조회 ──────────────────────────────────────────────────────

  /**
   * GET /api/payment/my-plan
   * 로그인한 사용자의 현재 구독 플랜을 반환합니다.
   * Authorization 헤더로 토큰을 전달해야 합니다.
   *
   * @header {string} Authorization - Bearer 토큰 또는 API 토큰
   * @returns {{ plan: string, planInfo: object } | { error: string }}
   */
  router.get('/payment/my-plan', (req, res) => {
    const token = req.headers.authorization || req.query.token;                  // 헤더 또는 쿼리에서 토큰 추출
    const user  = verifyToken(token);                                            // 토큰으로 사용자 검증
    if (!user) return res.status(401).json({ error: 'unauthorized' });           // 미인증 시 401

    const userPlan = user.plan || 'free';                                        // 기본값 free
    res.json({
      plan: userPlan,                                                            // 현재 플랜 ID
      planInfo: PLANS[userPlan] || PLANS.free,                                   // 플랜 상세 정보
    });
  });

  // ── 구독 취소 ──────────────────────────────────────────────────────────

  /**
   * POST /api/payment/cancel
   * 현재 구독을 취소하고 Free 플랜으로 다운그레이드합니다.
   * MOCK_MODE 에서는 즉시 Free로 변경합니다.
   *
   * @header {string} Authorization - Bearer 토큰
   * @body   {string} [subscriptionId] - Stripe 구독 ID (선택 — 미제공 시 사용자 DB에서 조회)
   * @body   {string} [cancelReason]   - 취소 사유 (선택)
   * @returns {{ success: boolean, plan: 'free' } | { error: string }}
   */
  router.post('/payment/cancel', async (req, res) => {
    const token = req.headers.authorization || req.query.token;                  // 토큰 추출
    const user  = verifyToken(token);                                            // 사용자 검증
    if (!user) return res.status(401).json({ error: 'unauthorized' });           // 미인증 시 401

    try {
      const { subscriptionId } = req.body || {};

      // Stripe 구독 취소 (Mock 모드에서는 즉시 성공 반환)
      await cancelSubscription({
        subscriptionId: subscriptionId || user.subscriptionId || user.id,
      });

      upgradePlan(user.id, 'free');                                              // DB에서 Free로 다운그레이드

      res.json({
        success: true,                                                           // 성공
        plan: 'free',                                                            // 변경된 플랜
        message: '구독이 취소되었습니다. Free 플랜으로 전환됩니다.',                   // 안내 메시지
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Stripe Customer Portal 세션 생성 ────────────────────────────────────

  /**
   * POST /api/payment/portal
   * Stripe Customer Portal 세션을 생성합니다.
   * 사용자가 스스로 결제 수단 변경, 구독 관리, 청구서 확인을 할 수 있습니다.
   *
   * @header {string} Authorization - Bearer 토큰
   * @body   {string} [customerId] - Stripe Customer ID (선택 — 미제공 시 사용자 DB에서 조회)
   * @returns {{ url: string } | { error: string }}
   */
  router.post('/payment/portal', async (req, res) => {
    const token = req.headers.authorization || req.query.token;                  // 토큰 추출
    const user  = verifyToken(token);                                            // 사용자 검증
    if (!user) return res.status(401).json({ error: 'unauthorized' });           // 미인증 시 401

    try {
      const customerId = req.body?.customerId || user.stripeCustomerId || user.id;

      const result = await createCustomerPortalSession({ customerId });

      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Checkout 성공 리다이렉트 콜백 ──────────────────────────────────────

  /**
   * GET /api/payment/success
   * Stripe Checkout 완료 후 리다이렉트되는 콜백 엔드포인트입니다.
   * 세션을 확인하고 결제 성공 페이지로 리다이렉트합니다.
   *
   * @query {string} session_id - Stripe Checkout Session ID
   * @returns {redirect} 결제 결과 페이지로 리다이렉트
   */
  router.get('/payment/success', async (req, res) => {
    const { session_id } = req.query;

    if (!session_id) {
      return res.redirect('/orbit3d.html?paymentFail=true&error=missing_session');
    }

    try {
      const result = await confirmPayment({ sessionId: session_id });

      if (result && (result.payment_status === 'paid' || result.mock)) {
        const planId = result.metadata?.planId;
        const userId = result.metadata?.userId;

        // 플랜 업그레이드 (Webhook에서도 처리하지만 이중 안전 장치)
        if (userId && planId && PLANS[planId]) {
          upgradePlan(userId, planId);
        }

        res.redirect(`/orbit3d.html?paymentSuccess=true&plan=${planId || 'pro'}`);
      } else {
        res.redirect('/orbit3d.html?paymentFail=true&error=payment_incomplete');
      }
    } catch (e) {
      res.redirect(`/orbit3d.html?paymentFail=true&error=${encodeURIComponent(e.message)}`);
    }
  });

  return router;
}

module.exports = createRouter;
