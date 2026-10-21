# 직원 작업데이터 완전성 설계 (감지 → 원인분류 → 자동복구 → 보고)

작성 2026-10-21. 사장님 지시: "파이프라인에서 드러난 유실을 해결 가능하게 구조를 설계변경할 것."
실측 근거: `nenova-work-features/observed/_devel-1021-report.md` §4.

## 0. 유실 4종과 한 줄 원칙

| # | 유실 | 실측 | 종전 구조의 결함 | 설계 변경 |
|---|---|---|---|---|
| ① | 서버 조회 한도 80건 절단 | 직원당 로컬 300~700건(30일)인데 `/api/vision/work-records` 가 80건만 반환(hours=720, limit=5000 요청해도) | `Math.min(limit, 80)` 숨은 상한, 소비자는 절단을 알 길 없음 | 상한 제거(≤1000) + 커서 페이지네이션 + 응답에 `total`·`truncated`·`next_cursor` 명시. 소비자는 `next_cursor` 가 null 일 때까지 순회 |
| ② | "받은 만큼"만 처리 | 파이프라인이 기대치를 모름 | 완전성 지표 없음 | 서버가 직원·일자별 캡처/분석/기대치를 집계(`/api/completeness`), 파이프라인은 run-all 시작에 읽어 accuracy JSON·/my-work(자가수정 보고)에 '기대 대비 수신률' 표시, 50% 미만 '유실' |
| ③ | 평일 캡처 0건 PC | 아드리아나 10일 중 7일 0건, 정재훈 하루 10건, 강현우 3일 0건 | daemon-health 는 **최근 1시간 heartbeat 만** 봐서 며칠 죽은 PC 는 목록에서 사라짐(아드리아나 10/12 마지막 heartbeat → 10/21 health 에 없음) | heartbeat × 입력(keyboard/mouse.chunk) × 캡처 셋을 교차해 '데몬 다운 / PC 꺼짐 / 사람 미사용 / 큐 적체 / 장기 무응답' 자동 분류, 데몬 다운이면 restart 자동 발송(카나리 → 전체, 호스트당 하루 1회) |
| ④ | 카톡 110방 중 최근 7일 0건 87방 | 분모에 죽은 방이 섞임 | 방 활성/비활성 구분 없음 | `pull-kakao.js` 가 방별 최근 메시지 시각을 집계해 7일 0건 방을 `inactive` 로 표시(`observed/_kakao-rooms.json`), 완전성 지표의 분모는 활성 방만 |

원칙: **"받아야 할 양 대비 얼마나 받았는지"** 를 매일 숫자로 내고, 50% 미만은 사람 눈에 '유실'로 보이게 하며, 원인이 데몬이면 사람 손 없이 원격으로 고친다.

## 1. 서버 조회 API (①)

`GET /api/vision/work-records` (관리자)

| 파라미터 | 의미 |
|---|---|
| `userId` | 필수 |
| `since`, `until` | ISO 시각. `since` 없으면 `hours`(기본 336, 최대 720) |
| `limit` | 기본 40, **최대 1000** (종전 80) |
| `cursor` | 직전 응답의 `next_cursor` (키셋: `timestamp|id` base64, `ORDER BY timestamp DESC, id DESC`) |
| `wf` / `stage` | 종전과 동일(선택) |

응답: `{ ok, total, count, truncated, next_cursor, records[] }`
- `total` = 조건 전체 건수(커서 무관) → 소비자는 받은 합계와 비교해 절단 0 을 스스로 검증한다.
- `truncated=true` 면 반드시 `next_cursor` 로 이어 받는다.
- 커서는 오프셋이 아니라 키셋이라 수집 중 새 이벤트가 들어와도 중복·누락 없음.

소비자: `nenova-work-features/pull-observed.js` — 직원당 `limit=1000` 로 `next_cursor` 가 null 일 때까지 순회(단계·업무별 분할 호출 제거). 로그에 `서버 total N / 수신 N / truncated=false` 를 찍는다. ops-agent 등 다른 소비자도 같은 계약을 쓴다.

## 2. 완전성 게이트 (②) — `src/completeness.js`

`GET /api/completeness?days=7` (관리자, 10분 캐시)

집계(한 번의 GROUP BY, 원본 행을 서버 메모리로 안 끌어옴):
```
SELECT user_id, type, (timestamp::timestamptz AT TIME ZONE 'Asia/Seoul')::date, COUNT(*)
  FROM events WHERE type IN (screen.capture, screen.analyzed, keyboard.chunk, mouse.chunk, daemon.heartbeat)
   AND timestamp >= now-35d GROUP BY 1,2,3
```
- 기대치 = **최근 4주 같은 요일** 캡처 수의 중앙값. 수신률 = 캡처/기대치(일별 100% 상한으로 7일 합산).
- 직원별: `overallPct`, `lost`(50% 미만), `lostDays`, `causes{}`, `days[]{date, capture, analyzed, keyboard, mouse, heartbeat, expected, receivedPct, status, cause}`
- 파이프라인: `pull-completeness.js` 가 run-all 시작에 저장(`observed/completeness.json`) → `build-observed-workflows.js merge` 가 accuracy JSON 에 `completeness{receivedPct, lost, lostDays, causes}` 를 직원별로 넣고 → `self-tune-report.js` 요약 한 줄("작업데이터 수신 …") → `/my-work` 도입 레이더(자가수정 보고) 표시 + `adoption-ledger` 에 매일 누적.

## 3. 캡처 0 분류 + 자동복구 (③)

| heartbeat | 입력(kbd/mouse) | 캡처 | 분류 | 자동 조치 |
|---|---|---|---|---|
| >0 | >0 | 0 | **데몬 다운**(캡처 모듈 죽음) | restart 발송 |
| >0 | 0 | 0 | 사람 미사용 | 없음 |
| 0 | >0 | 0 | **데몬 다운**(heartbeat 모듈 죽음) | restart 발송 |
| 0 | 0 | 0, 평일 2일↑ 연속 | **장기 무응답**(데몬 다운 의심) | restart 발송 — 소비되면 'PC 켜져 있었음'=데몬 다운 확정, 미소비면 PC 꺼짐 |
| 0 | 0 | 0 | PC 꺼짐 | 없음 |
| — | — | >0, 분석 0 | 큐 적체 | 없음(비전 워커 쪽) |
| — | — | 기대의 50% 미만 | 부분 유실 | 없음(표시만) |

자동복구 규칙(10/12 사고 재발 방지):
- **ALL 큐 사용 금지.** 개별 호스트 PG 큐(`orbit_daemon_commands`)에만 넣고, 기존 `GET /api/daemon/commands` 가 ctid 로 1회 소비.
- hostname 키 = 최근 14일 안에 **실제 소비된 명령의 hostname 표기**(살아있는 폴링 키) 우선, 없으면 최신 heartbeat 의 hostname(대소문자 분열 함정).
- 호스트당 **하루 1회** (`orbit_completeness_actions` 에 기록), 미소비 restart 가 대기 중이면 중복 적재 안 함.
- 게이트: `COMPLETENESS_AUTO_RESTART=off|canary|all` (기본 canary), `COMPLETENESS_CANARY_HOSTS=호스트,…`. 카나리 밖은 dry-run 으로만 기록(표에 보임).
- 예약: 1시간마다, 평일 09~19 KST. 수동: `POST /api/completeness/recover?dryRun=1`.
- 데몬 재설치·재부팅은 하지 않는다. restart 는 `process.exit → bat 재시작`(기존 경로).

## 4. 보고

- `GET /api/completeness/report-line` → 한 줄 텍스트. `nenovakakao/send_report.py` 가 매일 09:00 카톡 보고에 덧붙인다(실패 시 '수신 지표 조회 실패' 한 줄).
- 예: `작업데이터 수신(최근 7일, 50% 미만=유실): 유실 2명 — 아드리아나 0%(장기무응답5), 정재훈 31%(부분3) / 자동 restart 발송: 아드리아나/DESKTOP-XXXX`

## 5. 검증(완료 조건)

1. 서버 절단 0: 직원별 `total` == 수신 건수, `truncated=false` 로 끝남(전후표: 80 → 전량).
2. 완전성 %: `accuracy-YYYY-MM-DD.json` 의 `employees[*].completeness` 와 `/my-work` 자가수정 보고 요약 줄.
3. 캡처 0건 날: `/api/completeness` 의 `days[].cause` 로 직원×날짜 원인표.
4. 자동 restart: `orbit_completeness_actions` 행 + `orbit_daemon_commands` 소비 시각(카나리 1대).

## 6. 남는 위험
- 기대치가 0 인 신규/퇴사 직원은 '기준없음'(status none) 으로 분모에서 빠진다.
- PC 꺼짐과 장기 데몬 다운은 restart 큐의 소비 여부로만 사후 구분된다(사전 구분 불가).
- `mouse.chunk` 를 안 보내는 구버전 데몬은 입력=keyboard 만으로 판단한다.
