'use strict';
/**
 * security-scanner.js
 * 보안 유출 감지 모듈
 * AI 프롬프트/응답/파일에서 민감 정보 패턴 탐지
 *
 * 사용:
 *   const { scanForLeaks, LEAK_PATTERNS } = require('./security-scanner');
 *   const leaks = scanForLeaks(events);  // MindmapEvent[]
 */

// ─── 감지 패턴 목록 ──────────────────────────────────
// 각 패턴: { name, regex(global), severity: 'critical'|'high'|'medium' }
const LEAK_PATTERNS = [
  {
    name: 'API Key',
    // api_key / apikey / api-key / api_token 뒤에 오는 16자 이상 값 (Bearer 포함)
    regex: /(?:api[_-]?key|apikey|api[_-]?token)\s*[:=]\s*(?:Bearer\s+)?['"]?[\w\-]{16,}/gi,
    severity: 'critical',
  },
  {
    name: 'AWS Key',
    // AWS Access Key ID: AKIA + 16 대문자/숫자
    regex: /AKIA[0-9A-Z]{16}/g,
    severity: 'critical',
  },
  {
    name: 'Private Key',
    // PEM 형식 비공개 키 헤더
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    severity: 'critical',
  },
  {
    name: 'JWT Token',
    // eyJ... . eyJ... . 서명부 (3 세그먼트)
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    severity: 'high',
  },
  {
    name: 'GitHub Token',
    // ghp_ (personal), ghs_ (server), gho_ (oauth), ghu_ (user), ghr_ (refresh)
    regex: /gh[pousr]_[A-Za-z0-9]{36}/g,
    severity: 'critical',
  },
  {
    name: 'DB URL',
    // DB 연결 문자열 (mongodb, postgres, mysql, redis)
    regex: /(?:mongodb|postgres|postgresql|mysql|redis):\/\/\S+/gi,
    severity: 'high',
  },
  {
    name: 'Password',
    // password / passwd / pwd / secret = 'somevalue'
    regex: /(?:password|passwd|pwd|secret)\s*[:=]\s*['"]?[^\s'"]{6,}/gi,
    severity: 'high',
  },
  {
    name: 'Slack Token',
    // Slack Bot/App/User 토큰
    regex: /xox[baprs]-[A-Za-z0-9\-]{10,}/g,
    severity: 'critical',
  },
  {
    name: 'Private IP',
    // 내부망 IP 주소 (192.168.x.x / 10.x.x.x / 172.16-31.x.x)
    regex: /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g,
    severity: 'medium',
  },
  {
    name: 'Email 무더기',
    // 이메일 주소 2개 이상 연속 (대량 이메일 노출)
    regex: /(?:[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[\s,;]\s*){2,}/g,
    severity: 'medium',
  },
  {
    name: 'Bearer Token',
    // Authorization: Bearer 뒤에 오는 토큰
    regex: /Bearer\s+[A-Za-z0-9\-._~+/=]{20,}/g,
    severity: 'high',
  },
  {
    name: 'SSH Key',
    // OpenSSH / RSA 공개키/비공개키
    regex: /-----BEGIN OPENSSH PRIVATE KEY-----/g,
    severity: 'critical',
  },
];

/**
 * 이벤트 배열에서 민감 정보 패턴 탐지
 * @param {Array<{id:string, type:string, data:{content?:string}, timestamp?:string}>} events
 * @returns {Array<{name:string, severity:string, ctx:string, eventId:string, timestamp:string}>}
 */
function scanForLeaks(events) {
  if (!events || events.length === 0) return [];

  const results = [];
  // 중복 방지: eventId + patternName 쌍
  const seen = new Set();

  for (const event of events) {
    if (!event) continue;

    // 스캔 대상 텍스트 수집
    const parts = [
      event.data?.content || '',
      event.data?.contentPreview || '',
      event.data?.inputPreview || '',
      event.data?.filePath || '',
    ];
    const text = parts.join(' ');
    if (!text.trim()) continue;

    for (const pat of LEAK_PATTERNS) {
      // global regex는 lastIndex 리셋 필수
      pat.regex.lastIndex = 0;

      const dedupeKey = `${event.id}::${pat.name}`;
      if (seen.has(dedupeKey)) continue;

      const match = pat.regex.exec(text);
      if (match) {
        seen.add(dedupeKey);
        results.push({
          name:      pat.name,
          severity:  pat.severity,
          ctx:       match[0].substring(0, 80),   // 최대 80자 (개인정보 보호)
          eventId:   event.id,
          timestamp: event.timestamp || new Date().toISOString(),
        });
      }
    }
  }

  return results;
}

module.exports = { scanForLeaks, LEAK_PATTERNS };
