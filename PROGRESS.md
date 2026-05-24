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
- 병합 후보 확정 버튼을 추가해 work unit validation/evidence에 ERP intake ID를 저장
- 추출 파서를 AI 보정 단계와 연결해 애매한 문장은 Claude/GPT 검증으로 넘기기

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
