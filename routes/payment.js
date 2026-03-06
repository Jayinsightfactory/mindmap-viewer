/**
 * routes/payment.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 결제/구독 플랜 API 라우터 (Toss Payments PG 연동)
 *
 * 담당 엔드포인트:
 *   GET  /api/payment/plans   - 구독 플랜 목록 (free/pro/team)
 *   POST /api/payment/create  - 결제 요청 생성 (결제창 초기화)
 *   POST /api/payment/confirm - 결제 승인 + DB 플랜 업그레이드
 *   GET  /api/payment/my-plan - 현재 사용자 구독 플랜 조회
 *   POST /api/payment/cancel  - 구독 취소 (Free 다운그레이드)
 *
 * 환경 변수:
 *   TOSS_SECRET_KEY 미설정 → MOCK_MODE 활성화 (실제 결제 없음)
 *   TOSS_SECRET_KEY 설정   → 실제 Toss Payments API 호출
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();

/**
 * @param {object} deps - 의존성 객체
 * @param {object} deps.payment         - { PLANS, createPayment, confirmPayment, cancelSubscription, MOCK_MODE }
 * @param {function} deps.upgradePlan   - (userId, plan) => boolean — 사용자 플랜 업그레이드
 * @param {function} deps.verifyToken   - (token) => user|null — 토큰 검증
 * @returns {express.Router}
 */
function createRouter(deps) {
  const { payment, upgradePlan, verifyToken } = deps;                            // 의존성 분해
  const { PLANS, createPayment, confirmPayment, cancelSubscription, MOCK_MODE: paymentMockMode } = payment;

  // ── 플랜 목록 ────────────────────────────────────────────────────────────

  /**
   * GET /api/payment/plans
   * 사용 가능한 구독 플랜 목록과 현재 MOCK_MODE 여부를 반환합니다.
   * 프론트엔드 결제 페이지의 플랜 선택 UI에서 사용합니다.
   * @returns {{ plans: Plan[], mockMode: boolean }}
   */
  router.get('/payment/plans', (req, res) => {
    res.json({ plans: Object.values(PLANS), mockMode: paymentMockMode });
  });

  // ── 결제 요청 생성 ───────────────────────────────────────────────────────

  /**
   * POST /api/payment/create
   * Toss Payments 결제창 초기화에 필요한 파라미터를 생성합니다.
   * MOCK_MODE 에서는 실제 API 호출 없이 테스트용 데이터를 반환합니다.
   *
   * @body {string} planId     - 플랜 ID ('pro' | 'team')
   * @body {string} userId     - 결제 사용자 ID
   * @body {string} userEmail  - 결제 사용자 이메일
   * @body {string} [orderId]  - 주문 ID (미지정 시 자동 생성)
   * @returns {{ orderId: string, amount: number, orderName: string, clientKey: string }}
   */
  router.post('/payment/create', async (req, res) => {
    try {
      const result = await createPayment(req.body);
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 결제 승인 ────────────────────────────────────────────────────────────

  /**
   * POST /api/payment/confirm
   * Toss Payments 결제 완료 후 최종 승인을 처리합니다.
   * 승인 성공 시 사용자 플랜을 DB에 업그레이드합니다.
   *
   * @body {string} paymentKey - Toss Payments 에서 발급한 결제 키
   * @body {string} orderId    - 결제 요청 시 사용한 주문 ID
   * @body {number} amount     - 결제 금액 (검증용)
   * @body {string} userId     - 결제한 사용자 ID
   * @body {string} planId     - 업그레이드할 플랜 ID
   * @returns {{ success: boolean, payment: object, plan: string }}
   */
  router.post('/payment/confirm', async (req, res) => {
    try {
      const { paymentKey, orderId, amount, userId, planId } = req.body;          // 요청 바디에서 필드 추출
      const result = await confirmPayment({ paymentKey, orderId, amount });      // PG 결제 승인 요청

      // 결제 승인 성공 시 사용자 플랜 업그레이드
      if (result.status === 'DONE' || result.mock) {                             // 실결제 또는 목 모드 둘 다 처리
        if (userId && planId && PLANS[planId]) {                                 // 유효한 사용자·플랜인지 확인
          upgradePlan(userId, planId);                                           // DB에 플랜 업데이트
        }
      }

      res.json({
        success: true,                                                           // 성공 여부
        payment: result,                                                         // PG 승인 결과
        plan: planId || null,                                                    // 업그레이드된 플랜 ID
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 현재 플랜 조회 ──────────────────────────────────────────────────────────

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

  // ── 구독 취소 ──────────────────────────────────────────────────────────────

  /**
   * POST /api/payment/cancel
   * 현재 구독을 취소하고 Free 플랜으로 다운그레이드합니다.
   * MOCK_MODE 에서는 즉시 Free로 변경합니다.
   *
   * @header {string} Authorization - Bearer 토큰
   * @body   {string} [cancelReason] - 취소 사유 (선택)
   * @returns {{ success: boolean, plan: 'free' } | { error: string }}
   */
  router.post('/payment/cancel', async (req, res) => {
    const token = req.headers.authorization || req.query.token;                  // 토큰 추출
    const user  = verifyToken(token);                                            // 사용자 검증
    if (!user) return res.status(401).json({ error: 'unauthorized' });           // 미인증 시 401

    try {
      // PG 구독 취소 (목 모드에서는 즉시 성공 반환)
      if (cancelSubscription) {                                                  // cancelSubscription 함수가 있으면
        await cancelSubscription({
          billingKey: user.id,                                                   // 빌링 키 (목 모드에선 무시됨)
          cancelReason: req.body.cancelReason || '사용자 요청',                    // 취소 사유
        });
      }

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

  return router;
}

module.exports = createRouter;
