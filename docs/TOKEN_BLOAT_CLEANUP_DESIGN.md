# orbit_auth_tokens 적체 정리 설계 (2026-11-06)

> 상태: **설계만** — 이 문서 시점에 코드/DB 변경 없음. 각 단계는 사용자 승인 후 개별 실행.
> 관련: 기동 힙 피크 근본원인(= admin 토큰 862만행 전량 로드)은 `_adminBootstrap` LIMIT 1000(커밋 6faaa15)로 이미 해결. 본 문서는 **적체 자체**를 줄이고 재발을 막는다.

## 1. 실측 현황 (읽기 전용 조사)

| 항목 | 값 |
|---|---|
| 총 행수 | **13,477,677** |
| 테이블 크기 | 2,748 MB |
| type=session | 13,477,654 (type=api 23) |
| expires_at IS NULL(만료없음) | 13,477,655 (만료설정 22) |
| last_used_at IS NULL(미사용) | 13,459,669 (≈99.87%) |
| 최근 7일 생성 | 3,827,167 (**≈540k/일 발급**) |
| 생성 30일 초과 | 5,983,258 |
| admin(dlaww584) 소유 | 8,620,563 (987MB) |
| 인덱스 | (user_id, created_at DESC), (token) |

**해석:** 발급되는 토큰이 대부분 `session`·무만료·무사용. 만료가 없어 영구 적체. ≈540k/일로 계속 증가.

## 2. 발급 근본원인

- 신규 고유 토큰을 만들어 `_pgBackupToken(token, userId, null)`([src/auth.js:756])로 PG 저장 — `type` 미지정→기본 `session`, `expires_at=null`→무만료. `ON CONFLICT DO NOTHING`이라 재삽입이 아니라 **매번 새 고유 토큰**이 쌓인다.
- login 경로는 +30일 만료를 주므로(그건 자연소멸) 본 적체의 주범이 아님. 무만료 대량분은 재등록/데몬 토큰 백업 계열([src/auth.js:847], [server.js:354] 등)로 추정.
- `last_used_at`은 토큰 사용 시 1시간 1회 갱신([src/auth.js:588])되며, 2026-09-07에 **이 정리를 위해** 추가됨(당시 446만 → 현재 1347만).

> ⚠️ 구현 1단계에서 **정확한 발급 지점을 계측으로 확정**한다(아래 §3-A). grep 추정만으로 발급 로직을 바꾸지 않는다.

## 3. 정리 설계 (단계적 — 각 단계 독립 승인·검증)

### A. 발급 지점 확정 (출혈 지점 특정) — 코드 미변경, 계측 1회
- `_pgBackupToken`에서 `type`이 session으로 기본되고 `expiresAt==null`인 호출에 한해, **짧은 창(예: 10분)** 동안 호출 스택 요약을 카운터로 집계(로그 레이트리밋 회피 위해 볼륨 파일/메모리 집계 후 1줄 출력).
- 완료조건: "어느 코드 경로가 무만료 session 토큰을 분당 몇 개 만드는가"를 수치로 확정.

### B. 출혈 멈춤 (발급 측 수정) — §A 확정 후
우선순위대로, 확정된 발급 지점에 적용:
1. **재사용**: 같은 userId의 유효 토큰이 이미 있으면 새로 만들지 않고 재사용.
2. **만료 부여**: 그래도 새로 만들어야 하면 `expires_at`을 유한값(예: +30일)으로 저장 → 자연소멸.
3. (선택) `_pgBackupToken` 기본 만료를 null→+30일로 바꾸되, api 토큰 등 무만료가 필요한 호출은 명시적으로 null 전달.
- 검증: 적용 후 `created_at > now()-1h` 신규 session 행 증가율이 급감(예: 540k/일 → 수천/일).

### C. 안전 인덱스 추가 (삭제 가속) — 배치 삭제 전
```sql
-- 부분 인덱스: 미사용·무만료 session 토큰 스캔/삭제 가속 (CONCURRENTLY로 락 없이)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_oat_cleanup
  ON orbit_auth_tokens (created_at)
  WHERE last_used_at IS NULL AND type='session';
```

### D. 백로그 안전 삭제 (배치, 보수적 기준)
**삭제 대상(보수 1차):** `type='session' AND last_used_at IS NULL AND created_at < NOW() - INTERVAL '30 days'`
- 근거: 생성 30일 초과 + 사용흔적 없음. 활성 데몬 토큰은 (a) 재배포마다 PG verify로 `last_used_at`이 찍히거나 (b) 최근 재발급되어 30일 이내 → 대상에서 제외됨. 예상 ≈598만행.
- **보존(절대 삭제 안 함):** `type='api'`, `last_used_at IS NOT NULL`(사용흔적), `created_at >= NOW()-30d`(최근), 그리고 **사용자별 최신 N개**(아래 가드).
- **가드(데몬 설치토큰 오삭제 방지):** 삭제 전, 사용자별 최신 토큰은 보존.
```sql
-- 배치 삭제(한 번에 50k, 반복). 피크시간 회피. 각 배치 후 커밋.
WITH keep AS (  -- 사용자별 최신 5개는 무조건 보존
  SELECT token FROM (
    SELECT token, row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) rn
    FROM orbit_auth_tokens
  ) s WHERE rn <= 5
)
DELETE FROM orbit_auth_tokens
WHERE ctid IN (
  SELECT ctid FROM orbit_auth_tokens
  WHERE type='session' AND last_used_at IS NULL
    AND created_at < NOW() - INTERVAL '30 days'
    AND token NOT IN (SELECT token FROM keep)
  LIMIT 50000
);
-- rowcount>0인 동안 반복. 완료 후 VACUUM (비FULL).
```
- 실행 주체: 관리자(SSMS/psql)가 수동 실행하거나, 1회성 관리 스크립트. **웹 GET 경로로 삭제 금지**(규칙: GET=읽기전용).

### E. 재발 방지 (상시)
- B가 핵심. 추가로 주기 정리: 기존 일일 유지보수(`_runDailyMaintenance`)에 `type='session' AND last_used_at IS NULL AND created_at < NOW()-INTERVAL '30 days'` 배치 삭제(소량·상한)를 편입.
- `expires_at` 기본 유한화로 신규분은 자연소멸.

## 4. 검증 (각 단계 before/after)
```sql
SELECT count(*) total,
       count(*) FILTER (WHERE type='session' AND last_used_at IS NULL AND created_at < NOW()-INTERVAL '30 days') deletable,
       pg_size_pretty(pg_total_relation_size('orbit_auth_tokens')) sz
FROM orbit_auth_tokens;
```
- D 후: total 급감, 크기 축소(VACUUM 후), 기동 VmHWM/토큰쿼리 추가 개선 확인.
- **데몬 인증 회귀 체크:** 삭제 직후 DATA_CHECK §1 daemon-health 연결수·§3 capture-funnel 유지 확인. 401 급증 시 중단·원복점검.

## 5. 롤백/안전
- 삭제 대상은 **무만료·무사용·30일+**로, 사용 중이면 애초에 제외됨 → 삭제가 인증을 깨면 안 됨(설계상).
- 그럼에도 1차 배치는 소량(예: 10만)만 하고 §4 회귀 체크 후 확대.
- 만일 특정 데몬이 옛 토큰을 들고 있다 401나면: 기존 self-heal/`POST /api/daemon/claim-token`([server.js:8025])이 재발급 — 사용자 개입/재설치 불필요.
- 삭제 토큰은 복구 불필요(무사용). 필요시 삭제 전 `SELECT token INTO temp_deleted ...`로 스냅샷 보관 가능.

## 6. 금지선
- 웹 GET으로 삭제 금지. `type='api'`·사용흔적·최근·사용자별 최신 N개 삭제 금지. 데몬 코드/설치 변경 없음(서버·DB만). FULL VACUUM(락) 지양 — 일반 VACUUM.
