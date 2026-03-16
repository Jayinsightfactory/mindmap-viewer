/**
 * src/validate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * API 입력 검증 헬퍼
 *
 * 사용법:
 *   const { validateBody } = require('../src/validate');
 *   const err = validateBody(req.body, {
 *     email: { required: true, type: 'email' },
 *     password: { required: true, type: 'string', minLength: 6 },
 *   });
 *   if (err) return res.status(400).json({ error: err });
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

/**
 * 요청 body의 필드를 규칙에 따라 검증합니다.
 * @param {object} body - req.body
 * @param {object} rules - { fieldName: { required, type, minLength, maxLength } }
 *   type: 'string' | 'email' | 'array'
 * @returns {string|null} 오류 메시지 또는 null (통과)
 */
function validateBody(body, rules) {
  for (const [field, rule] of Object.entries(rules)) {
    const val = body?.[field];
    if (rule.required && (val === undefined || val === null || val === '')) {
      return `${field} 필드가 필요합니다`;
    }
    if (val !== undefined && val !== null && val !== '') {
      if (rule.type === 'string' && typeof val !== 'string') {
        return `${field}는 문자열이어야 합니다`;
      }
      if (rule.type === 'email') {
        if (typeof val !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
          return `올바른 이메일 형식이 아닙니다`;
        }
      }
      if (rule.type === 'array' && !Array.isArray(val)) {
        return `${field}는 배열이어야 합니다`;
      }
      if (rule.minLength && String(val).length < rule.minLength) {
        return `${field}는 최소 ${rule.minLength}자 이상이어야 합니다`;
      }
      if (rule.maxLength && String(val).length > rule.maxLength) {
        return `${field}는 최대 ${rule.maxLength}자까지 가능합니다`;
      }
    }
  }
  return null;
}

module.exports = { validateBody };
