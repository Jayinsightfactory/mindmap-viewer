'use strict';

const { normalizeEvent, augmentPrompt } = require('../../src/rag-core');

describe('rag-core', () => {
  describe('normalizeEvent', () => {
    test('키보드 이벤트 정규화', () => {
      const event = {
        type: 'keyboard.chunk',
        data_json: {
          windowTitle: '네노바 - 주문 관리',
          app: 'nenova',
          rawInput: 'A001\t100',
          activity: '데이터 입력',
        },
      };
      const { content, metadata } = normalizeEvent(event);
      expect(content).toContain('[키입력]');
      expect(content).toContain('nenova');
      expect(content).toContain('주문 관리');
      expect(content).toContain('A001');
      expect(metadata.app).toBe('nenova');
    });

    test('캡처 이벤트 정규화', () => {
      const event = {
        type: 'screen.capture',
        data_json: {
          windowTitle: '화훼 관리 프로그램 v1.0.13',
          app: 'other',
          trigger: 'idle_result',
        },
      };
      const { content, metadata } = normalizeEvent(event);
      expect(content).toContain('[캡처]');
      expect(content).toContain('화훼 관리');
      expect(metadata.screen).toContain('화훼');
    });

    test('Vision 분석 이벤트 정규화', () => {
      const event = {
        type: 'screen.analyzed',
        data_json: {
          windowTitle: '주문 등록',
          dataVisible: '품번, 수량, 거래처명',
          automationHint: '폼 자동 입력 가능',
          automatable: 'true',
        },
      };
      const { content, metadata } = normalizeEvent(event);
      expect(content).toContain('[Vision분석]');
      expect(content).toContain('자동화가능');
      expect(metadata.automatable).toBe(true);
    });

    test('클립보드 이벤트 정규화', () => {
      const event = {
        type: 'clipboard.change',
        data_json: {
          text: 'CARNATION FLOWER 500EA',
          windowTitle: '엑셀 - 발주서.xlsx',
        },
      };
      const { content } = normalizeEvent(event);
      expect(content).toContain('[클립보드]');
      expect(content).toContain('CARNATION');
    });

    test('data_json 문자열 파싱', () => {
      const event = {
        type: 'keyboard.chunk',
        data_json: JSON.stringify({
          windowTitle: '테스트 윈도우',
          rawInput: 'hello',
        }),
      };
      const { content } = normalizeEvent(event);
      expect(content).toContain('테스트 윈도우');
    });

    test('빈 이벤트 처리', () => {
      const { content } = normalizeEvent({ type: 'unknown' });
      expect(content).toContain('[unknown]');
    });
  });

  describe('augmentPrompt', () => {
    test('RAG 문서 없으면 원본 반환', () => {
      const result = augmentPrompt({
        systemPrompt: '시스템',
        userQuery: '질문',
        retrievedDocs: [],
      });
      expect(result).toBe('시스템\n\n질문');
    });

    test('RAG 문서 포함 시 증강', () => {
      const result = augmentPrompt({
        systemPrompt: '시스템 프롬프트',
        userQuery: '다음 행동은?',
        retrievedDocs: [
          { content: 'nenova 주문 입력', ts: '2026-03-25T10:00:00Z', score: 0.9 },
          { content: 'Excel 차감 처리', ts: '2026-03-25T11:00:00Z', score: 0.8 },
        ],
      });
      expect(result).toContain('## 관련 데이터');
      expect(result).toContain('nenova 주문 입력');
      expect(result).toContain('Excel 차감 처리');
      expect(result).toContain('## 질문');
    });

    test('maxContextLen 초과 시 잘림', () => {
      const longDocs = Array(100).fill(null).map((_, i) => ({
        content: `문서 ${i}: ${'데이터'.repeat(50)}`,
        ts: new Date().toISOString(),
        score: 0.5,
      }));
      const result = augmentPrompt({
        systemPrompt: '시스템',
        userQuery: '질문',
        retrievedDocs: longDocs,
        maxContextLen: 500,
      });
      // 500자 제한이므로 모든 문서가 포함되지 않아야 함
      expect(result.length).toBeLessThan(2000);
    });
  });
});
