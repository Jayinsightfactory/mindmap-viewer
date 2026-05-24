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

---

## 작업 (2026-05-24) — Nenova 작업 단위 API 저장/동기화 고도화

### 1. API 수신함 영속화 (완료)
- `GET/POST /api/work-units`를 서버 메모리 배열에서 파일 저장형 수신함으로 변경
- `nenova-erp-ui/data/work-units.json`에 최대 2000건 저장
- 동일 `id` 재수신 시 덮어써서 PC 이벤트/카카오 매칭 보정 가능
- `mouse.chunk`, `keyboard.chunk`, `screen.analyzed`, `nenova.exe` payload를 `sourceEventType`으로 정규화

### 2. 화면 동기화 (완료)
- `/work-units`가 localStorage 시드 데이터와 API 수신 데이터를 병합해서 표시
- API 수신 건수와 수동 동기화 버튼 추가
- API 수신 데이터도 계정별 업무영역, 대화 매칭, 3차 검증 통계에 반영

### 3. 송신 계약 문서/샘플 (완료)
- `docs/nenova-exe-work-unit-ingest.md`에 실제 `nenova.exe` 송신 페이로드 계약 기록
- `scripts/post-work-unit-sample.ps1`로 샘플 작업 단위 전송 가능
- PowerShell 실행 안정성을 위해 샘플 스크립트는 ASCII 페이로드 사용

### 4. 검증 (완료)
- `npm run build` 성공
- 샘플 POST 후 `GET /api/work-units`에서 수신 1건 확인
- 수신 샘플이 `대화후작업` / `부분일치`로 정규화되는 것 확인
- `/work-units` HTTP 200 확인

### 다음 단계
- 기존 `routes/process-mining.js`의 PC/카카오/구글시트 병합 결과를 `/api/work-units`로 직접 전달
- 카카오톡/카카오워크 수신 이벤트를 `relatedTalks`로 자동 매핑
- 운영 DB 도입 시 `data/work-units.json`을 work_unit 원장 테이블로 승격

---

## 작업 (2026-05-24) — Process Mining → Nenova Work Units 브릿지

### 1. 이벤트 블록 확장 (완료)
- process-mining 분석 타입에 `mouse.chunk` 추가
- 활동 블록에 `clickCount`, `clickEvidence` 유지
- recorder click도 작업 단위 클릭 근거로 반영

### 2. 작업 단위 후보 API (완료)
- `GET /api/mining/work-units` 추가
- 사용자/기간 기준으로 PC 이벤트를 작업 블록으로 묶고 네노바웹 `/api/work-units` 페이로드로 변환
- 30분 창 안의 KakaoTalk 이벤트를 `relatedTalks`로 자동 매칭

### 3. 네노바웹 전송 API (완료)
- `POST /api/mining/work-units/push` 추가
- `targetUrl` 또는 `NENOVA_WORK_UNITS_URL`로 작업 단위 후보 일괄 전송
- 기본값은 `http://localhost:3000/api/work-units`

### 4. 검증 (완료)
- `node --check routes/process-mining.js` 성공
- `node --check server.js` 성공
- `npm run build` 성공

### 다음 단계
- KakaoWork 수신 콜백도 `relatedTalks` 후보에 포함
- 직원 계정 매핑 테이블을 붙여 `userId` 대신 네노바 계정 ID를 자동 확정
- `/work-units`에서 process-mining push 실행 결과를 운영자가 볼 수 있는 버튼/로그 추가

---

## 작업 (2026-05-24) — KakaoWork Callback → Work Unit 후보 등록

### 1. 콜백 수신 저장 (완료)
- `POST /api/kakaowork/callback`이 수신 이벤트를 `data/kakaowork-events.json`에 저장
- `GET /api/kakaowork/callback`으로 최근 수신 이벤트 확인 가능
- 콜백 시크릿 검증 유지

### 2. 의도 추론과 작업 단위 등록 (완료)
- 메시지 텍스트에서 견적, 계약, 프로젝트, 할 일, 재고, 정산, 보고, AI검토 카테고리 1차 추론
- 기본적으로 `/api/work-units`에 `KakaoWork` 작업 단위 후보 자동 등록
- `syncWorkUnit: false`로 등록 생략 가능

### 3. 교차검증 상태 보정 (완료)
- 카카오워크 단독 수신 후보는 `미연결` / `검증대기`로 보존
- 이후 PC 작업 또는 ERP 원장과 연결될 때 `대화후작업`, `동시진행`, `작업후대화`로 승격할 수 있게 함

### 4. 검증 (완료)
- `npm run build` 성공
- 샘플 카카오워크 콜백 POST 성공
- `/api/work-units`에서 `KW-WU-kw-msg-sample-001` 후보 저장 확인

### 다음 단계
- 직원 이메일/카카오워크 userId와 네노바 계정 ID 매핑 테이블 추가
- 카카오워크 콜백에서 실제 할 일/견적 초안 생성으로 이어지는 승인 플로우 구현
- `/work-units`에서 카카오워크 단독 후보를 PC 작업과 수동 병합하는 UI 추가

---

## 작업 (2026-05-24) — 직원 계정 매핑 디렉터리

### 1. 내부 직원 디렉터리 (완료)
- `employee-directory.ts` 추가
- 내부 로그인 ID, 표시 이름, accountId, 팀, 기본 업무영역, 이메일, KakaoWork userId, Orbit userId, PC hostname, 별칭을 통합
- 임재용, 설연주, 강현우, 박성수 4명 기준 등록

### 2. API 연결 (완료)
- `GET /api/employees/directory` 추가
- query로 `userEmail`, `userId`, `kakaoworkUserId`, `hostname`, `employeeName`, `accountId`를 넣으면 내부 계정 해석 결과 반환
- `/api/kakaowork/callback`과 `/api/work-units`가 같은 매핑 함수를 사용
- `/work-units` 카드에 계정 매핑 근거와 신뢰도 배지 표시

### 3. 검증 (완료)
- `worker@example.com` → 설연주 / `nenova:sales-support:sul-yeonju` 매핑 확인
- `kw-user-001` 카카오워크 콜백 → 작업 단위 후보가 내부 계정으로 저장되는 것 확인
- `npx tsc --noEmit` 성공
- dev 서버 재시작 후 `/work-units` HTTP 200 확인

### 참고
- `npm run build`는 `.next/server/app/assistant.segments` 파일 잠금으로 실패했습니다. 코드 타입 검증은 `npx tsc --noEmit`으로 통과했습니다.

### 다음 단계
- 디렉터리를 파일/DB 기반으로 편집 가능하게 만들기
- `/work-units` 화면에 매핑 신뢰도와 매칭 근거 표시
- KakaoWork 승인 액션이 실제 ERP task/quote 생성으로 이어지게 연결

---

## 작업 (2026-05-24) — KakaoWork → ERP 수신함

### 1. ERP Intake API (완료)
- `GET/POST/PATCH /api/erp/intake` 추가
- 카카오워크/외부 요청을 견적, 할 일, 재고, 정산, 프로젝트, 질문 초안으로 저장
- 로컬 운영 데이터는 `data/erp-intake.json`에 보관

### 2. KakaoWork callback 연결 (완료)
- 견적/할 일/재고/정산/프로젝트 의도는 callback 수신 시 ERP 수신함에 자동 등록
- `syncErpIntake: false`로 수신함 등록 생략 가능
- 직원 디렉터리로 owner/accountId/team 정규화

### 3. ERP 흐름 화면 연결 (완료)
- `/erp-flow`에 "카카오워크 ERP 수신함" 추가
- 견적 후보는 회의/녹음 기록으로 등록해 기존 견적 생성 흐름에 태움
- 그 외 요청은 담당자 할 일로 등록
- 수신 항목 보류/초안 복귀 가능

### 4. 검증 (완료)
- `npx tsc --noEmit` 성공
- 샘플 KakaoWork 콜백 → `ERP-IN-KW-kw-msg-sample-erp-001` 견적 수신함 생성 확인
- `/erp-flow` HTTP 200 확인

### 다음 단계
- 견적 초안 금액/고객/마감일 추출 자동화
- 카카오워크 버튼 액션으로 승인/보류/전환 실행

---

## 작업 (2026-05-24) — ERP 수신함 전환 추적

### 1. 서버 수신함 링크 필드 (완료)
- `/api/erp/intake`에 `linkedEntityType`, `linkedEntityId`, `convertedAt`, `conversionNote` 저장 필드 추가
- 전환 완료 시 전환 시각을 서버에 남김

### 2. ERP 흐름 화면 연결 (완료)
- `/erp-flow`에서 카카오워크 수신함 항목을 전환할 때 생성된 회의/할 일 ID를 수신함 PATCH로 되돌려 저장
- 카드에서 연결된 ERP 객체 ID와 전환 메모 표시

### 3. 검증 (완료)
- `npx tsc --noEmit` 성공
- `POST/PATCH /api/erp/intake`로 링크 필드 저장 확인
- `/erp-flow` HTTP 200 확인

### 다음 단계
- 카카오워크 버튼 액션으로 승인/보류/전환 실행
- 전환된 수신함과 `/work-units`의 PC 작업 단위를 자동 병합하는 후보 UI 추가

---

## 작업 (2026-05-24) — ERP 수신함 초안 자동 추출

### 1. 고객/금액/마감 파서 (완료)
- `/api/erp/intake`에서 메시지 기반 고객명, 공급가, 목표일 추출 추가
- `320만원`, `1,200,000원`, `1.5억`, `오늘/내일/모레`, `5월 30일`, `D+3`, `다음주 금요일` 형태 처리
- 추출 근거를 evidence에 남겨 반복 오류 추적 가능하게 함

### 2. ERP 전환 강화 (완료)
- `/erp-flow` 수신함 카드에 고객/공급가 표시
- 견적 요청에 공급가가 있으면 전환 시 회의 기록과 견적 초안을 함께 생성
- 전환 결과는 `linkedEntityType: quote`와 견적 ID로 수신함에 연결

### 3. 검증 (완료)
- `npx tsc --noEmit` 성공
- 카카오워크 샘플 콜백 `대한상사에서 견적 320만원 내일까지 부탁드립니다.`가 고객/금액/목표일로 추출되는 것 확인
- `/erp-flow` HTTP 200 확인

### 다음 단계
- 전환된 수신함과 `/work-units`의 PC 작업 단위를 자동 병합하는 후보 UI 추가
- 추출 파서를 AI 보정 단계와 연결해 애매한 문장은 Claude/GPT 검증으로 넘기기

---

## 작업 (2026-05-24) — KakaoWork 액션 처리

### 1. 액션 API (완료)
- `GET/POST /api/kakaowork/action` 추가
- `approve`, `hold`, `restore`, `convert` 액션을 ERP 수신함 상태 변경으로 매핑
- 실행자 정보를 직원 디렉터리로 해석해 `lastAction`에 저장

### 2. 콜백 연결 (완료)
- `/api/kakaowork/callback`이 `actions.action` + `actions.intakeId`를 감지하면 action route로 전달
- 액션 콜백은 별도 ERP 초안을 중복 생성하지 않게 분기

### 3. 화면 표시 (완료)
- `/erp-flow` 수신함 카드에 마지막 카카오워크 액션, 실행자, 실행 시각 표시
- `승인완료` 상태 스타일 추가

### 4. 검증 (완료)
- `npx tsc --noEmit` 성공
- `GET /api/kakaowork/action` 응답 확인
- 직접 action `convert`와 callback action `hold` 성공 확인
- `/erp-flow` HTTP 200 확인

### 다음 단계
- 전환 요청이 들어온 수신함 항목을 `/erp-flow`에서 한 번에 실제 견적/할 일로 생성하는 자동 실행 버튼 추가
- 추출 파서를 AI 보정 단계와 연결해 애매한 문장은 Claude/GPT 검증으로 넘기기

---

## 작업 (2026-05-24) — Work Unit ↔ ERP Intake 병합 후보

### 1. 후보 API (완료)
- `GET /api/work-units/intake-candidates` 추가
- `work-units.json`과 `erp-intake.json`을 비교해 병합 후보 점수화
- 같은 카카오워크 이벤트, 내부 계정, 카테고리, 고객, 시간창, ERP 연결 여부를 근거로 사용

### 2. 화면 표시 (완료)
- `/work-units`에 "ERP 수신함 병합 후보" 섹션 추가
- 후보별 작업 단위/ERP 수신함/점수/추천/근거 태그 표시
- 검증 기준 카드에 ERP 병합 후보 건수 표시

### 3. 검증 (완료)
- `npx tsc --noEmit` 성공
- `GET /api/work-units/intake-candidates` 응답 확인
- 샘플 매칭이 89점 `자동 병합 후보`로 잡히는 것 확인
- `/work-units` HTTP 200 확인

### 다음 단계
- 추출 파서를 AI 보정 단계와 연결해 애매한 문장은 Claude/GPT 검증으로 넘기기

---

## 작업 (2026-05-24) — Work Unit ↔ ERP Intake 병합 확정

### 1. 확정 API (완료)
- `POST /api/work-units/intake-candidates` 추가
- `workUnitId`, `intakeId`, `note`를 받아 work unit의 검증 상태와 evidence 업데이트
- `erp_intake`, `erp_intake_status`, `erp_merge_score`, `erp_merge_reason` 근거 저장

### 2. 화면 버튼 (완료)
- `/work-units` 병합 후보 카드에 `병합 근거 저장` 버튼 추가
- 확정 후 후보 목록과 작업단위 목록 새로고침
- 성공/실패 메시지 표시

### 3. 검증 (완료)
- `npx tsc --noEmit` 성공
- 샘플 후보 확정 시 `validationStatus=일치`, `erp_merge_score=89` 저장 확인
- `/work-units` HTTP 200 확인

### 다음 단계
- 확정된 병합 후보를 `/work-units` 목록에서 별도 필터로 볼 수 있게 하기

---

## 작업 (2026-05-24) — ERP Intake AI 보정 큐

### 1. AI 보정 API (완료)
- `GET/POST /api/erp/intake/ai-review` 추가
- 추출 근거가 부족한 수신함을 고객/금액/마감일 기준으로 큐잉
- POST 시 `/api/assistant`로 `erp-intake-ai-review` 컨텍스트 전달

### 2. 화면 연결 (완료)
- `/erp-flow`에 "AI 보정 큐" 섹션 추가
- 누락 필드와 우선순위 표시
- `AI 보정 요청` 버튼으로 Claude/GPT 경로 호출

### 3. 검증 (완료)
- `npx tsc --noEmit` 성공
- `GET /api/erp/intake/ai-review` 응답 확인
- 샘플 보정 요청이 `claude-demo` 응답으로 반환되는 것 확인
- `/erp-flow` HTTP 200 확인

### 다음 단계
- AI 보정 응답을 JSON으로 파싱해 수신함 초안에 제안값으로 표시하기

---

## 작업 (2026-05-24) — Work Units 검증상태 필터

### 1. 필터 추가 (완료)
- `/work-units`에 검증상태 필터 추가
- `전체`, `일치`, `부분일치`, `충돌`, `검증대기` 선택 가능

### 2. 검증 (완료)
- `npx tsc --noEmit` 성공
- `/work-units` HTTP 200 확인

### 다음 단계
- AI 보정 응답을 JSON으로 파싱해 수신함 초안에 제안값으로 표시하기

---

## 작업 (2026-05-24) — 직원 워크플로우 중심 재정렬

### 1. 우선순위 변경 (완료)
- 사용자의 정정 반영: ERP가 아니라 `nenova.exe` 작업데이터, 카톡/워크 대화, PC 작업데이터 기반 직원별 업무 파악이 핵심
- `/work-units` 상단 문구와 검증 기준을 직원 워크플로우 중심으로 변경
- ERP 병합 후보는 보조 데이터 연결 후보로 내림

### 2. 직원별 업무 흐름 (완료)
- 직원별 작업 수, 작업 시간, 대화 연결, PC 근거, 소스 비중, 최근 흐름 표시
- 직원별 업무 리스크 표시: 흐름 안정, 대화 근거 부족, PC 근거 부족, 검증 보강, 충돌 확인

### 3. 회사 전체 워크플로우 (완료)
- 업무 카테고리 전환 예측 추가
- 시간대별 업무량 추가
- 데이터 소스 커버리지 추가
- 확인 필요한 흐름 추가

### 4. 메뉴/문서 (완료)
- 사이드바 `작업 단위`를 `직원 워크플로우`로 변경
- `docs/nenova-work-unit-cross-validation.md`를 ERP 중심이 아닌 직원 워크플로우 중심으로 수정

### 5. 검증 (완료)
- `npx tsc --noEmit` 성공
- `/work-units` HTTP 200 확인

### 다음 단계
- `nenova.exe` 실제 수집 필드 기준으로 작업 단위 payload를 더 촘촘히 맞추기

---

## 작업 (2026-05-24) — KakaoTalk 원본 메시지 연결

### 1. 카톡 메시지 수집 API (완료)
- `GET/POST /api/kakaotalk/messages` 추가
- 단건/배치 메시지 저장 지원
- KakaoTalk 내보내기 텍스트 `rawText` 파싱 지원
- 저장 위치: `data/kakaotalk-messages.json`

### 2. 카톡 ↔ 작업단위 후보 API (완료)
- `GET/POST /api/work-units/talk-candidates` 추가
- 시간차, 카테고리, 대화방명, 미연결 여부로 후보 점수화
- 확정 시 `relatedTalks`, `talkRelation`, `evidence`, `validationMemo` 갱신

### 3. 화면 연결 (완료)
- `/work-units`에 "카톡 연결 후보" 섹션 추가
- 후보별 작업 단위/카톡 메시지/점수/관계/근거 표시
- `카톡 근거 저장` 버튼 추가

### 4. 검증 (완료)
- `npx tsc --noEmit` 성공
- `/work-units` HTTP 200 확인
- 샘플 카톡 메시지와 `nenova.exe` 작업 단위가 90점 `대화후작업` 후보로 잡히고 저장되는 것 확인

### 다음 단계
- `nenova.exe` 실제 수집 필드 기준으로 작업 단위 payload를 더 촘촘히 맞추기
- 카톡 연결 후보를 직원별 워크플로우 카드의 리스크 산정에 더 강하게 반영하기

---

## 작업 (2026-05-24) — Nenova.exe 원본 이벤트 브릿지

### 1. 원본 이벤트 수집 API (완료)
- `GET/POST /api/nenova-exe/events` 추가
- 원본 저장 위치: `data/nenova-exe-events.json`
- 단건, 배열, `{ events: [] }`, `{ items: [] }` 형태 지원

### 2. Work Unit 자동 동기화 (완료)
- 원본 이벤트를 직원 작업 단위 payload로 정규화
- 내부적으로 `/api/work-units`에 동기화
- `nenova.exe`/PC source 구분
- hostname/email/accountId/KakaoWork userId 기반 직원 매칭
- 클릭, 키보드, 화면 요약, active window, process, 실행 경로를 evidence로 저장

### 3. 문서화 (완료)
- `docs/nenova-exe-work-unit-ingest.md`에 원본 이벤트 계약 추가
- 지원 필드와 정규화 규칙 추가

### 4. 검증 (완료)
- `npx tsc --noEmit` 성공
- `GET /api/nenova-exe/events` HTTP 200 확인
- 샘플 이벤트 POST 시 `workUnitSync.ok=true`, 직원 `설연주`, 카테고리 `견적` 확인
- 테스트 데이터 정리 완료
- `/work-units` HTTP 200 확인

### 다음 단계
- `nenova.exe` 이벤트와 카톡/카카오워크 메시지 매칭 결과를 직원별 리스크 점수에 더 강하게 반영하기
- PC 이벤트가 너무 잘게 쌓일 때 세션 단위 병합 규칙 추가하기

---

## 작업 (2026-05-24) — PC 세션 병합 후보

### 1. 세션 병합 API (완료)
- `GET/POST /api/nenova-exe/sessions` 추가
- `data/nenova-exe-events.json` 원본 이벤트를 `accountId + sessionId + category + appName` 기준으로 병합
- 기본 `gapMin=5`분, 이벤트 간격이 이보다 크면 다른 세션으로 분리
- `NX-SESSION-...` 작업 단위 payload 생성

### 2. Work Units 화면 연결 (완료)
- `/work-units`에 "PC 세션 병합 후보" 섹션 추가
- raw 이벤트 수와 세션 후보 수 표시
- 후보별 이벤트 수, 작업 시간, 클릭, 화면 근거, 직원/업무영역 표시
- `세션 작업단위 저장` 버튼으로 `/api/work-units`에 병합 세션 저장

### 3. 문서화 (완료)
- `docs/nenova-exe-work-unit-ingest.md`에 세션 병합 엔드포인트와 규칙 추가

### 4. 검증 (완료)
- `npx tsc --noEmit` 성공
- 샘플 이벤트 2건이 기본 `gapMin=5`에서 하나의 세션 후보로 병합되는 것 확인
- 세션 저장 시 `/api/work-units` 동기화 성공 확인
- `gapMin` 미입력 시 1분으로 줄어들던 숫자 파싱 버그 수정
- 테스트 데이터 정리 완료
- `GET /api/nenova-exe/sessions` HTTP 200 확인
- `/work-units` HTTP 200 확인

### 다음 단계
- 저장된 세션 작업 단위와 카톡/카카오워크 후보를 자동으로 우선 매칭하기
- 직원별 리스크 점수에서 "세션 후보 있음/미저장" 상태를 반영하기

---

## 작업 (2026-05-24) — 톡/워크 후보 우선 매칭

### 1. 후보 API 확장 (완료)
- `/api/work-units/talk-candidates`가 KakaoTalk와 KakaoWork 이벤트를 함께 읽도록 확장
- 카카오워크 이벤트를 내부 직원 `accountId`로 정규화
- `same_account`, `kakaowork_source`, `session_work_unit` 점수 신호 추가
- 카카오톡/카카오워크 단독 work unit은 후보 target에서 제외하고 PC/nenova.exe/세션 작업 단위만 우선 매칭

### 2. 화면 반영 (완료)
- `/work-units`의 "카톡 연결 후보"를 "톡/워크 연결 후보"로 변경
- 후보 카드에 `KakaoTalk`/`KakaoWork` 메시지 source 표시
- 직원별 업무 흐름 카드에 미저장 세션 후보가 있으면 `세션 후보 N` 리스크 배지 표시

### 3. 문서화 (완료)
- `docs/nenova-exe-work-unit-ingest.md`에 톡/워크 후보 규칙 추가
- `docs/nenova-work-unit-cross-validation.md`에 Talk/Work candidate scoring 추가

### 4. 검증 (완료)
- `npx tsc --noEmit` 성공
- `GET /api/work-units/talk-candidates`에서 `kakaoworkMessages`, `targetWorkUnits`와 카카오워크 후보 확인
- `/work-units` HTTP 200 확인
- 브라우저에서 "톡/워크 연결 후보"와 `KakaoWork 메시지` 렌더링 확인

### 다음 단계
- 카카오워크 메시지와 PC 세션 후보를 확정할 때, 같은 시간대 ERP/구글시트 결과 근거까지 자동으로 같이 붙이기

---

## 작업 (2026-05-24) — Work Units 데이터 원장화

### 1. 방향 수정 (완료)
- 사용자 정정 반영: 통계가 아니라 명확한 원본 작업 데이터가 먼저 보여야 함
- `/work-units` 상단 문구를 "직원 작업 데이터 원장"으로 변경

### 2. 실제 데이터 테이블 추가 (완료)
- 첫 주요 섹션을 "실제 작업 데이터" 원장 테이블로 변경
- 컬럼: 작업ID/시간, 직원/계정, 작업 내용, PC 화면, 대화 원문, 원본 근거, 검증
- 원본 근거에 raw event id, session id, talk id, hostname, process, active window, clicks, keys, screen summary 표시

### 3. 통계/예측 화면 숨김 (완료)
- 통계 카드 숨김
- 회사 전체 워크플로우 예측 숨김
- 시간대별 업무량 숨김
- 데이터 소스 커버리지 숨김
- 계정별 요약과 관계별 요약 숨김

### 4. 검증 (완료)
- `npx tsc --noEmit` 성공
- `/work-units` HTTP 200 확인
- 브라우저에서 실제 작업 데이터 원장과 컬럼 렌더링 확인
- 이전 통계/예측 문구가 화면에 보이지 않는 것 확인
- 텍스트 overflow 문제 없음

### 다음 단계
- 실제 `nenova.exe` raw 이벤트가 쌓였을 때 원본 근거 컬럼에 누락 필드가 없는지 샘플 운영 데이터로 재점검

---

## 작업 (2026-05-24) — `/workflow` 별도 페이지

### 1. 라우트 추가 (완료)
- `nenova-erp-ui/src/app/(app)/workflow/page.tsx` 추가
- 실제 작업 데이터 원장 UI를 `/workflow`에서 볼 수 있게 연결
- 기존 `/work-units`는 유지

### 2. 사이드바 변경 (완료)
- `직원 워크플로우` 메뉴 href를 `/workflow`로 변경

### 3. 검증 (완료)
- `npx tsc --noEmit` 성공
- `/workflow` HTTP 200 확인
- 브라우저에서 `/workflow` 접근 시 데이터 원장 컬럼 렌더링 확인

### 다음 단계
- 배포 도메인에서는 `https://nenovaweb.com/workflow`로 접근하면 같은 화면이 보이게 됨

---

## 작업 (2026-05-24) — ERP Flow 전환 요청 큐

### 1. 전환 요청 표시 (완료)
- `/erp-flow` 수신함에서 `requestedConversionAt`이 있는 카카오워크 전환 요청을 별도 강조
- 헤더에 실행 대기 건수 표시
- 카드에 `전환 요청됨` 배지와 파란 배경 표시

### 2. 실행 버튼 문구 (완료)
- 금액이 있는 견적 요청은 `견적 초안 생성`
- 그 외 전환 요청은 `전환 요청 실행`
- 일반 견적 요청은 `회의/견적 후보 등록`
- 일반 업무 요청은 `할 일 등록`

### 3. 검증 (완료)
- `npx tsc --noEmit` 성공
- `/erp-flow` HTTP 200 확인

### 다음 단계
- 병합 후보 확정 버튼을 추가해 work unit validation/evidence에 ERP intake ID를 저장
- 추출 파서를 AI 보정 단계와 연결해 애매한 문장은 Claude/GPT 검증으로 넘기기

---

## 작업 (2026-05-24) — Watcher 데이터 품질 보강

### 1. 금요일 작업 이어서 수정 (완료)
- 기준 작업: 2026-05-22 금요일 마지막 커밋 `4c9efb0 fix: 데이터 품질 3종 수정`
- 목적: `nenova.exe` 작업데이터, 카톡/카카오워크 대화데이터, PC 작업데이터를 합칠 때 앱명/창제목/클립보드 오염이 다시 섞이지 않게 함

### 2. 공통 필터 추가 (완료)
- `src/data-quality.js` 추가
- 앱명 정규화: `.exe` 별칭 처리, JSON/버전번호/PowerShell/프로세스목록 차단
- 창제목 정제: 프로세스목록/PowerShell 차단, 이메일/URL 파라미터/사용자 경로 마스킹
- 클립보드 필터: 시스템 노이즈는 제거하고 견적/발주/테이블 텍스트는 유지

### 3. watcher 적용 (완료)
- `keyboard-watcher.js`: Windows/macOS/Linux 앱명·창제목 수집과 분석 payload에 공통 필터 적용
- `clipboard-watcher.js`: 클립보드 노이즈 판정과 source app/window 정제에 공통 필터 적용
- `screen-capture.js`: 캡처 프로파일 키와 서버 전송 app/windowTitle에 공통 필터 적용
- `nenova.exe`, `msedge.exe`, `chrome.exe` 등이 `unknown`으로 빠지지 않게 보정

### 4. 검증 (완료)
- `npx jest tests\data-quality.test.js --runInBand` 성공
- watcher 3개 모듈 로드 확인 성공
- `npx jest --runInBand` 성공
- 전체 8개 테스트 스위트, 144개 테스트 통과

### 다음 단계
- 실제 운영 데이터가 들어오면 `/workflow` 원장 화면에서 source app/window/title/evidence가 오염 없이 연결되는지 샘플 검증

---

## 작업 (2026-05-24) — 입고단가·송금 변경내역 리스트

### 1. 메뉴/화면 정리 (완료)
- `/inventory` 메뉴명을 `입고단가·송금`으로 변경
- 화면 상단에 입고단가·송금 관리 목적이 바로 보이도록 문구 추가

### 2. 변경내역 데이터 모델 (완료)
- 품목에 `transferStatus`, `transferMemo`, `updatedAt` 추가
- `ProductChangeRecord` 추가
- 입고/출고, 단가변경, 송금상태 변경, 품목등록 이력 저장
- 기존 localStorage 품목 데이터도 seed 기준 송금상태로 보정

### 3. 오른쪽 변경내역 패널 (완료)
- `변경내역 있는 품목` 사이드 패널 추가
- 변경내역이 있는 품목만 리스트화
- 품목별 최근 3건의 변경 타입, 전후값, 메모, 작업자, 시각 표시
- 각 품목에서 바로 `단가/송금` 수정 가능

### 4. 검증 (완료)
- `npx tsc --noEmit` 성공
- 브라우저 `/inventory`에서 `입고단가·송금`, `변경내역 있는 품목`, `송금완료`, `송금대기`, `단가변경` 표시 확인

### 다음 단계
- 실제 송금 API/은행 알림 데이터가 들어오면 `송금완료` 상태 변경을 수동이 아니라 외부 근거 기반으로 기록

---

## 작업 (2026-05-24) — 차수피벗 차수 입력 잘림 수정

### 1. 실제 소스 위치 확인 (완료)
- 사용자 화면: `/shipment/week-pivot?weekFrom=2026-21-01&weekTo=2026-21-01`
- 실제 소스는 `mindmap-viewer/nenova-erp-ui`가 아니라 `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업`
- 이전에 수정이 안 먹은 이유는 작업 대상 저장소가 달랐기 때문

### 2. 차수 입력 컴포넌트 수정 (완료)
- `lib/useWeekInput.js`
- `YYYY-WW-SS` 형식 포맷/입력/이전·다음 이동 지원
- 입력칸 폭 `60px` → `112px`
- 입력 컴포넌트 `flexShrink: 0` 처리

### 3. 차수피벗 라우트와 쿼리 반영 (완료)
- `pages/shipment/week-pivot.js` 추가
- `/shipment/week-pivot` 진입 시 기본으로 차수 피벗 탭 열기
- `weekFrom/weekTo` URL 쿼리를 초기 입력값으로 반영
- 차수 컨트롤 영역 `minWidth: max-content`, `overflow: visible` 처리

### 4. 검증 (완료)
- `npm run build` 성공
- 로컬 `http://127.0.0.1:3001/shipment/week-pivot?weekFrom=2026-21-01&weekTo=2026-21-01` 확인
- 입력값 `2026-21-01` 전체 표시 확인
- 브라우저 측정: `clientWidth=110`, `scrollWidth=110`, overflow 없음

### 5. 커밋/푸시 상태
- 로컬 커밋 완료: `6fbfeca fix: prevent week pivot input clipping`
- `Jayinsightfactory/nenova-erp-ui` 원격 푸시는 인증 프롬프트 요구로 자동 푸시 실패
- 사용자가 GitHub 인증을 갱신하면 `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업`에서 `git push origin master` 필요

---

## 작업 (2026-05-24) — 차수피벗 엑셀 자연어 컬럼

### 1. 엑셀 내보내기 수정 (완료)
- 실제 소스: `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\pages\shipment\stock-status.js`
- 차수피벗 엑셀 다운로드 헤더에 `자연어` 컬럼 추가
- 컬럼 위치: `국가 / 꽃 / 품명 / 자연어 / 차수별 업체...`
- 자연어 값: `국가 꽃 품명`

### 2. 검증 (완료)
- `npm run build` 성공

### 3. 커밋/푸시 상태
- `커서 작업` 저장소 로컬 커밋 예정/완료 후에도 원격 푸시는 인증 갱신 필요

---

## 작업 (2026-05-24) — 네노바웹 메뉴 정리

### 1. 메뉴 구조 정리 (완료)
- 단일 메뉴 목록을 그룹형 메뉴로 변경
- 그룹: `홈`, `실무 처리`, `검증·자동화`

### 2. 겹치는 메뉴명 축약 (완료)
- `ERP 흐름` → `업무 흐름`
- `신규 주문` → `주문`
- `입고단가·송금` → `입고/송금`
- `고객 관리` → `고객`
- `직원 워크플로우` → `작업 원장`
- `워크 연동` → `카카오워크`

### 3. 사이드바 겹침 방지 (완료)
- 그룹 헤더 추가
- 아이콘 박스 폭 고정
- 라벨 `truncate` 적용
- 사이드바 메뉴 영역 스크롤 적용

### 4. 검증 (완료)
- `npx tsc --noEmit` 성공
- 브라우저 `/inventory`에서 그룹형 메뉴 렌더링 확인

### 다음 단계
- 실제 운영 메뉴가 더 늘어나면 `NAV_GROUPS`에만 추가해 사이드바 중복/겹침을 방지
