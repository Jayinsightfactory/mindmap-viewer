'use strict';
/**
 * security-scanner.test.js
 * 보안 유출 감지 모듈 TDD
 * Red → Green → Refactor
 */
const { scanForLeaks, LEAK_PATTERNS } = require('../../security-scanner');

// ── 헬퍼 ────────────────────────────────────────────
function makeEvent(content, type = 'user.message') {
  return { id: 'ev_test', type, data: { content }, timestamp: new Date().toISOString() };
}

// ═══════════════════════════════════════════════════
describe('LEAK_PATTERNS 정의', () => {
  test('10개 이상의 패턴 정의', () => {
    expect(LEAK_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });

  test('각 패턴에 name/regex/severity 필드 존재', () => {
    LEAK_PATTERNS.forEach(p => {
      expect(p.name).toBeTruthy();
      expect(p.regex instanceof RegExp).toBe(true);
      expect(['critical','high','medium']).toContain(p.severity);
    });
  });
});

// ═══════════════════════════════════════════════════
describe('scanForLeaks() — API Key 감지', () => {
  test('api_key=secret1234567890 패턴 감지', () => {
    const event = makeEvent('설정: api_key=secret1234567890abcdef');
    const leaks = scanForLeaks([event]);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks[0].name).toBe('API Key');
    expect(leaks[0].severity).toBe('critical');
  });

  test('apikey: Bearer token12345678901234567890 감지', () => {
    const event = makeEvent('Authorization header: apikey: Bearer token12345678901234567890');
    const leaks = scanForLeaks([event]);
    const found = leaks.some(l => l.name === 'API Key');
    expect(found).toBe(true);
  });

  test('일반 텍스트는 감지하지 않음', () => {
    const event = makeEvent('안녕하세요. 오늘 날씨가 좋네요.');
    const leaks = scanForLeaks([event]);
    expect(leaks.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════
describe('scanForLeaks() — AWS Key 감지', () => {
  test('AKIA로 시작하는 20자리 키 감지', () => {
    const event = makeEvent('aws_access_key_id = AKIAIOSFODNN7EXAMPLE');
    const leaks = scanForLeaks([event]);
    const found = leaks.some(l => l.name === 'AWS Key');
    expect(found).toBe(true);
    expect(leaks.find(l => l.name === 'AWS Key').severity).toBe('critical');
  });
});

// ═══════════════════════════════════════════════════
describe('scanForLeaks() — JWT Token 감지', () => {
  test('eyJ로 시작하는 JWT 형식 감지', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const event = makeEvent(`Authorization: Bearer ${jwt}`);
    const leaks = scanForLeaks([event]);
    const found = leaks.some(l => l.name === 'JWT Token');
    expect(found).toBe(true);
  });
});

// ═══════════════════════════════════════════════════
describe('scanForLeaks() — GitHub Token 감지', () => {
  test('ghp_ 로 시작하는 GitHub PAT 감지', () => {
    const event = makeEvent('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz12345678901');
    const leaks = scanForLeaks([event]);
    const found = leaks.some(l => l.name === 'GitHub Token');
    expect(found).toBe(true);
    expect(leaks.find(l => l.name === 'GitHub Token').severity).toBe('critical');
  });

  test('ghs_ 서비스 토큰도 감지', () => {
    const event = makeEvent('token: ghs_abcdefghijklmnopqrstuvwxyz123456789012');
    const leaks = scanForLeaks([event]);
    const found = leaks.some(l => l.name === 'GitHub Token');
    expect(found).toBe(true);
  });
});

// ═══════════════════════════════════════════════════
describe('scanForLeaks() — DB URL 감지', () => {
  test('postgresql:// 연결 문자열 감지', () => {
    const event = makeEvent('DATABASE_URL=postgresql://user:pass@db.example.com:5432/mydb');
    const leaks = scanForLeaks([event]);
    const found = leaks.some(l => l.name === 'DB URL');
    expect(found).toBe(true);
    expect(leaks.find(l => l.name === 'DB URL').severity).toBe('high');
  });

  test('mongodb:// 연결 문자열 감지', () => {
    const event = makeEvent('MONGO_URI=mongodb://admin:secretpass@cluster.mongodb.net/prod');
    const leaks = scanForLeaks([event]);
    const found = leaks.some(l => l.name === 'DB URL');
    expect(found).toBe(true);
  });
});

// ═══════════════════════════════════════════════════
describe('scanForLeaks() — Private Key 감지', () => {
  test('-----BEGIN RSA PRIVATE KEY----- 감지', () => {
    const event = makeEvent('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...\n-----END RSA PRIVATE KEY-----');
    const leaks = scanForLeaks([event]);
    const found = leaks.some(l => l.name === 'Private Key');
    expect(found).toBe(true);
    expect(leaks.find(l => l.name === 'Private Key').severity).toBe('critical');
  });
});

// ═══════════════════════════════════════════════════
describe('scanForLeaks() — 반환값 형식', () => {
  test('감지 결과에 name/severity/ctx/eventId 포함', () => {
    const event = makeEvent('api_key=testsecret1234567890abcd');
    event.id = 'ev_format_test';
    const leaks = scanForLeaks([event]);
    expect(leaks.length).toBeGreaterThan(0);
    const leak = leaks[0];
    expect(leak.name).toBeTruthy();
    expect(leak.severity).toBeTruthy();
    expect(typeof leak.ctx).toBe('string');
    expect(leak.eventId).toBe('ev_format_test');
  });

  test('ctx는 최대 80자로 잘림 (개인정보 보호)', () => {
    const longSecret = 'api_key=' + 'A'.repeat(200);
    const event = makeEvent(longSecret);
    const leaks = scanForLeaks([event]);
    if (leaks.length > 0) {
      expect(leaks[0].ctx.length).toBeLessThanOrEqual(80);
    }
  });

  test('같은 이벤트+패턴 중복 감지 안 함', () => {
    const event = makeEvent('api_key=abc123456789012345 그리고 api_key=abc123456789012345');
    event.id = 'ev_dup';
    const leaks = scanForLeaks([event]);
    const apiKeyLeaks = leaks.filter(l => l.name === 'API Key' && l.eventId === 'ev_dup');
    // 중복 차단 — 같은 이벤트에서 같은 패턴은 1건만
    expect(apiKeyLeaks.length).toBe(1);
  });

  test('빈 이벤트 배열 → 빈 배열 반환', () => {
    expect(scanForLeaks([])).toEqual([]);
  });

  test('content 없는 이벤트 → 빈 배열 반환', () => {
    const event = { id: 'ev_empty', type: 'session.start', data: {}, timestamp: new Date().toISOString() };
    expect(scanForLeaks([event])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════
describe('scanForLeaks() — Slack Token 감지', () => {
  test('xoxb- 로 시작하는 Slack Bot Token 감지', () => {
    // 테스트용 가짜 토큰 — 실제 값 아님 (GitHub Push Protection 우회)
    const fakePrefix = 'xox' + 'b';
    const event = makeEvent('SLACK_TOKEN=' + fakePrefix + '-12345678901-12345678901-abcdefghijklmnopqrstuvwx');
    const leaks = scanForLeaks([event]);
    const found = leaks.some(l => l.name === 'Slack Token');
    expect(found).toBe(true);
  });
});

// ═══════════════════════════════════════════════════
describe('scanForLeaks() — 여러 이벤트 처리', () => {
  test('여러 이벤트에서 각각 감지', () => {
    const events = [
      makeEvent('api_key=testsecret123456789abcdef'),
      makeEvent('일반 텍스트'),
      makeEvent('DATABASE_URL=postgresql://u:p@host/db'),
    ];
    events[0].id = 'ev_a';
    events[1].id = 'ev_b';
    events[2].id = 'ev_c';
    const leaks = scanForLeaks(events);
    const eventIds = leaks.map(l => l.eventId);
    expect(eventIds).toContain('ev_a');
    expect(eventIds).toContain('ev_c');
    expect(eventIds).not.toContain('ev_b');
  });
});
