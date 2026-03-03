/**
 * routes/payment.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 결제/구독 플랜 API 라우터 (Toss Payments PG 연동)
 *
 * 담당 엔드포인트:
 *   GET  /api/payment/plans   - 구독 플랜 목록 (free/pro/team)
 *   POST /api/payment/create  - 결제 요청 생성 (결제창 초기화)
 *   POST /api/payment/confirm - 결제 승인 (Toss Payments 최종 확인)
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
 * @param {object} deps.payment - { PLANS, createPayment, confirmPayment, MOCK_MODE }
 * @returns {express.Router}
 */
function createRouter(deps) {
  const { payment } = deps;
  const { PLANS, createPayment, confirmPayment, MOCK_MODE: paymentMockMode } = payment;

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
   * 프론트엔드에서 Toss SDK onSuccess 콜백 후 호출합니다.
   *
   * @body {string} paymentKey - Toss Payments 에서 발급한 결제 키
   * @body {string} orderId    - 결제 요청 시 사용한 주문 ID
   * @body {number} amount     - 결제 금액 (검증용)
   * @returns {{ success: boolean, payment: object }}
   */
  router.post('/payment/confirm', async (req, res) => {
    try {
      const result = await confirmPayment(req.body);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createRouter;
