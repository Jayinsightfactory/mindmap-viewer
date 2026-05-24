# Orbit AI — PROGRESS

> 최종 업데이트: 2026-04-13 (세션2)

---

## 작업 (2026-05-24) — 작업 기억/반복 오류 방지 체계 추가

### 완료
- `WORK_MEMORY.md` 추가: 대화 핵심 지시, 반복 수정 요청, 흩어진 저장소 정리 상태를 누적 기록
- `scripts/prework-search.ps1` 추가: 작업 전 관련 단어 검색을 표준화
- `CLAUDE.md`에 대화/수정요청 보존 프로토콜 추가
- `WORKSPACE.md` 운영 원칙에 작업 전 검색과 기억 누적 규칙 추가

### 지켜야 할 점
- 사용자의 이전 요청이 삭제되거나 잊히지 않도록 `WORK_MEMORY.md`를 계속 누적한다.
- 새 구현 전에 관련 단어를 먼저 검색한다.
- 반복 오류는 새로 만들기보다 기존 구현, 커밋, 배포, 연결 누락 여부를 먼저 진단한다.

---

## 작업 (2026-05-24) — Nenovaweb 첫 화면 운영 허브 + AI 비서 구조

### 완료
- `nenova-erp-ui` 첫 대시보드를 단순 메뉴/주문 카드에서 운영 허브로 확장
- 녹음 기록, 견적, 계약, 프로젝트, 할 일, 일정 보고, 매출/세금계산서 흐름을 첫 화면에 배치
- 기존 주문/재고/고객 메뉴와 기능은 유지
- `/assistant` 메뉴와 화면 추가
- `POST /api/assistant` 추가: Claude API 또는 OpenAI GPT API로 업무 질문 라우팅
- API 키가 없을 때는 데모 응답으로 동작하게 처리
- `operating-plan.ts`에 transcript 기반 구성 기획 모듈화

### 검증
- `npm run build` 성공
- 브라우저에서 `/dashboard` 로그인 후 운영 허브/AI 비서/최근 주문 표시 확인
- 브라우저에서 `/assistant` 질문 실행 후 데모 응답 표시 확인

### 다음 단계
- 실제 녹음/Plaud 또는 녹취 데이터 수집 API 연결
- 견적서 생성, 프로젝트 생성, 담당자 할 일 생성의 실제 저장소/API 연결
- 직원별 권한에 따라 AI가 접근 가능한 데이터 범위 제한

---

## 작업 (2026-05-24) — KakaoWork 기반 업무 게이트 기초 설계

### 완료
- 기존 `routes/issues.js`, `routes/automation-engine.js`의 KakaoWork `messages.send`/`conversations.open` 흔적 확인
- 공식 KakaoWork Web API 기준 확인: Bot App Key는 서버에서 `Authorization: Bearer`로 사용
- `/kakaowork` 화면 추가: 업무 흐름, 서버 API 초안, 환경변수, 데이터 매핑, 보안 체크 표시
- `POST /api/kakaowork/notify` 추가: conversationId/email/userId 대상 메시지 발송 또는 dryRun
- `POST /api/kakaowork/callback` 추가: 워크 이벤트 정규화와 다음 파이프라인 반환
- `docs/nenova-kakaowork-integration.md`에 통합 설계 문서화

### 검증
- `npm run build` 성공
- `GET /api/kakaowork/notify` 응답 확인
- `POST /api/kakaowork/notify` dryRun 응답 확인
- `POST /api/kakaowork/callback` 이벤트 정규화 응답 확인
- 브라우저에서 `/kakaowork` 메뉴, 제목, 업무 흐름, API 설계 표시 확인

### 다음 단계
- 실제 카카오워크 Bot App Key와 관리자 conversation ID 등록
- 직원 email ↔ KakaoWork user_id 매핑 테이블 생성
- 프로젝트/팀 채널 conversation_id 매핑
- 수신 이벤트를 주문/견적/프로젝트/할 일 생성 로직에 연결

---

## 작업 (2026-05-24) — ERP 흐름 실제 기능 1차 구현

### 완료
- `store.ts`를 주문/재고/고객 중심에서 회의/녹음, 견적, 프로젝트, 할 일, 세금계산서, 일일 보고까지 확장
- `/erp-flow` 화면 추가
- 회의/녹음 기록 등록 기능 추가
- 회의 기록에서 견적 생성 기능 추가
- 견적 계약 확정 시 프로젝트, 기본 할 일, 세금계산서 초안 자동 생성
- 프로젝트 상태/진행률 변경
- 담당자 할 일 상태 변경
- 세금계산서 상태 변경
- 일일 진행 보고 생성
- 대시보드 지표가 실제 ERP 저장 데이터 요약을 우선 표시하도록 변경
- AI 업무 콘솔이 현재 ERP 스냅샷을 `/api/assistant`에 함께 전달하도록 연결

### 검증
- `npm run build` 성공
- 브라우저에서 `/erp-flow` 렌더링 확인
- `/erp-flow`에 회의/녹음, 견적/계약, 프로젝트, 담당자 할 일, 매출/세금계산서, 일일 보고 섹션 표시 확인

### 남은 단계
- localStorage 기반 데이터를 실제 서버 DB로 이전
- Plaud/녹취 수집 API와 회의 기록 자동 생성 연결
- 홈택스 또는 세금계산서 대행 API 실제 발행 연결
- 카카오워크 수신 이벤트를 `/erp-flow` 업무 생성 로직에 직접 연결

---

## 작업 (2026-04-13) — 네노바 자동화 파이프라인 완성

### 1. launcher.pyw × Orbit 연동 (완료)
- launcher.pyw에 Orbit parse API 호출 코드 삽입 (`/api/automation/parse`)
- .env에 `ORBIT_SERVER` 추가
- 패치 위치 오류(IndentationError) → 수동 수정으로 해결
- launcher 정상 실행 확인 ✅

### 2. parse API 버그 수정 (완료)
- `bill_arrival` regex: `항공` 하드코딩 제거, multiline 지원 (`[\s\S]`)
- 영어 항공사명 (KOREAN AIR LINES) 정상 감지
- 테스트: boxes 90→95 변경 감지 + `arrivalAlert.type: "changed"` ✅

### 3. master_customers upsert 안정화 (완료)
- UNIQUE constraint 의존 → check/update/insert 방식으로 변경
- nenova_key 기준 안정적 동기화

### 남은 작업
- launcher.pyw Orbit 연동 코드 재삽입 (올바른 위치: classify_and_log_delta 이후)
- 실제 카톡 방 감시 → parse → 이슈 자동생성 E2E 테스트

---

## 최근 작업 (2026-04-12) — 32커밋

### 1. 데몬 자가복구 시스템 (완료)
- `REMOTE_URL` 상수 → `getRemoteUrl()` 동적 읽기
- 3중 자가복구: git remote URL + config serverUrl + 기동 시 즉시 체크
- 서버 5회 연속 실패 → git fetch 직접 비교 fallback
- install.ps1 / install-bank.ps1 재설치 시 git remote 자동 수리
- 잔존 dlaww@kicda.com / sparkling-determination 6개 파일 일괄 치환

### 2. 프로세스 마이닝 + 레코더 통합 (완료)
- recorder SQLite (mouse/keyboard/screenshot) → PG events 병합
- recording.js: vision-learning 클릭 동기화 + 통합 현황 API
- mouse_capture.py: Windows ctypes 포그라운드 윈도우 감지
- process-mining.js: fetchMergedEvents() — PG+SQLite 타임스탬프 병합

### 3. 카톡 분석 + 구글시트 연동 (완료)
- 구글시트 직접 읽기 (서비스계정 Railway 이스케이프 완전 해결)
- 3소스 교차 분석: 카톡 + 네노바 전산 + Vision 캡처
- 토탈분석 7탭 + 네노바 + 비전 교차분석 엔드포인트
- nenova 전산 직접 조회 (거래처/주문/출하/상품)

### 4. 네노바 자동화 파이프라인 (완료)
- 카톡 파서 재설계 (실제 메시지 포맷 기반: change_order/bill_arrival/MEL)
- Descr 통용명 자동 동기화 (master_customers)
- bill_arrival 트래킹 + KakaoWork 알림 (입고딜레이/수량변경 감지)
- nenova_key 기준 upsert, custKey null 버그 수정

### 5. 이슈 태스킹 시스템 (완료)
- `/api/biz-issues` — 카톡 파싱 이벤트에서 이슈 자동 생성
- `/issues.html` — 칸반 UI (백로그/진행/완료)
- KakaoWork 알림 연동

### 6. UI/UX (완료)
- 설치코드 발급 버튼 — 클릭 시 Google 계정 + PC 정보 뱃지 표시 후 토큰 포함 명령어 생성
- Orbit Company OS 통합 허브 (orbit-hub.html)
- 자동화 청사진 페이지 (automation-blueprint.html)

---

## 인프라 현황

| 항목 | 상태 |
|------|------|
| Railway 배포 | 정상 (main push → 자동배포) |
| 데몬 자가복구 | 3중 복구 + git fallback |
| 구글시트 연동 | 서비스계정 파싱 해결 완료 |
| nenova 4대 PC | 수동 재설치 1회 필요 (이후 자동) |

---

## 다음 단계
- nenova 4대 PC 설치코드 재실행 (발급 버튼으로 간편화됨)
- Vision 정밀 분석 고도화 (캡처→화면해독→자동화지점)
- 자동화 스크립트 자동 생성 엔진 (PAD/pyautogui/AHK)

---

## 작업 (2026-05-24) — Nenova Claude 검증 에이전트 + 작업 단위 화면

### 1. Claude 전용 에이전트 구성 (완료)
- `.claude/agents/nenova-data-fusion.md`: 카카오/구글시트, mindmap, nenovaweb ERP, nenova.exe, PC 클릭/화면 데이터를 작업 단위로 병합
- `.claude/agents/nenova-workflow-forecaster.md`: 15분/60분/240분/1일 업무 흐름 예측
- `.claude/agents/nenova-cross-validator.md`: 카카오톡/워크 대화, PC 클릭/작업, ERP 상태 3차 교차검증
- `.claude/agents/nenova-ops-orchestrator.md`: PASS/WARN/FAIL과 신뢰도 기반 최종 운영 답변

### 2. 네노바웹 작업 단위 구현 (완료)
- `/work-units` 페이지 추가
- 직원 계정, 팀, 업무영역, 작업 시간, 클릭 횟수, PC 근거, 카카오톡/워크 대화 매칭, 검증 상태 표시
- 대화→작업, 작업→대화, 동시진행 흐름을 분리해서 확인
- 대시보드에 작업 단위 지표와 링크 추가

### 3. 수집 API와 AI 컨텍스트 (완료)
- `GET/POST /api/work-units` 추가
- `nenova.exe`에서 보낼 payload 초안 정의
- AI 비서가 작업 단위 스냅샷과 3차 검증 기준을 컨텍스트로 사용하도록 반영

### 4. 검증 (완료)
- `npm run build` 성공
- `git diff --check` 통과
- `/work-units`, `/api/work-units`, `/dashboard` 로컬 확인 완료

### 다음 단계
- 실제 `nenova.exe` 이벤트 송신부에서 `/api/work-units`로 accountId/workArea/clickEvidence/relatedTalks 전송
- 기존 카카오톡/구글시트 파서 결과를 `relatedTalks` 구조로 매핑
- DB 원장 테이블로 localStorage 시드 데이터를 대체
