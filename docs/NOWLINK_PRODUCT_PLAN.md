# NOWLINK_PRODUCT_PLAN — 나우링크(nowlink.kr) 상용 출시 기획 (2026-10-18, 문서·점검만)

> **10줄 요약**
> 1. 상품 3단계: **나우링크 Watch**(데몬·동의 기반 업무 대시보드·승인형 자동화) → **나우링크 Build**(+생성형 ERP 화면) → **나우링크 Team**(+MOYI 메신저·승인/핸드오프).
> 2. 가격은 "PC(설치 대수) 단위 월과금 + 회사 기본료": Watch 1.9만/PC, Build 4.9만/PC+구축비, Team 6.9만/PC (제안값, 근거 §1-3).
> 3. 1단계 핵심 = **'동의받은 사람' 모델**(초대→동의→범위→철회). 현재 `config/privacy-policy.json`은 회사 단위 정책 파일 + 관리자 수동 명단이라 **셀프 초대·동의 기록·범위 선택·셀프 철회가 비어 있음**.
> 4. 2단계 MVP = 네노바웹 모듈 중 **견적 · 입고(+도착원가) · 차수보드** 3개를 "회사별 매핑 테이블"로 템플릿화. 네노바 자체를 1호 고객으로 기존 화면과 숫자 일치 검증.
> 5. 3단계 = 이미 있는 MOYI MCP 도구(`moyi_request_approval`·`moyi_create_task_card`·`moyi_notify_user`)를 승인 인박스·알림·핸드오프의 출구로 재사용(신규 메신저 개발 없음).
> 6. 점검: nowlink.kr 은 **이미 Railway Next.js 랜딩("나우링크 — 모든 사업장에 AI를 연결하다") 200 OK, Cloudflare NS, Let's Encrypt 인증서 2027-01-13 만료**. `/download` 는 404.
> 7. 브랜드 교체 규모: 코드 내 `orbit` 4,841회/370파일(이 중 `~/.orbit` 경로 446·PG `orbit_*` 725·ps1/bat 458 = 바꾸면 안 되는 내부 식별자), UI 노출 `Orbit` 807회. `nenova` 하드코딩 3,391회/129파일.
> 8. 출시 체크리스트 14항목 중 P0 해당 12항목: **완료 0 · 부분 6 · 미완 6**. 가장 위험: `/api/scripts` 가 인증 미들웨어 없이 마운트(server.js:8846) + `approve-run` 호출=승인(routes/script-generator.js:1169-1197).
> 9. 90일: 1~4주 보안·테넌트·실행 1건(네노바), 5~8주 서명 설치기·동의 흐름·베타 1사, 9~13주 Build MVP·과금·유료 1사.
> 10. **첫 2주 착수 3개**: ①`/api/scripts` 인증 + approve-run 승인자·상태 게이트(409/403) ②`workspace_id` 강제·하드코딩 owner 제거(비파괴 기본값 nenova) ③동의 레코드 테이블 + 초대/철회 API(정책 파일 명단을 DB 로 이전).

전제: '배운 일을 직접 실행'은 실행 0건(테스트 시작 단계). 선행 진단 [AGENT_GAP_AUDIT.md](AGENT_GAP_AUDIT.md) 평균 2.2/5.
이번 작업 범위: 기획·점검만(코드 배포·직원 PC 명령·DB 쓰기·DNS 변경 없음).

---

## 1. 상품 정의

### 1-1. 3단계 정의표

| | **① 나우링크 Watch** (데몬만) | **② 나우링크 Build** (데몬+생성형 ERP) | **③ 나우링크 Team** (데몬+ERP+MOYI) |
|---|---|---|---|
| 한 줄 | 깔면 내 일과 동의한 동료 일이 한 화면에 보이고, 반복 일은 승인 후 AI가 대신 | 일하는 모습을 보고 우리 회사용 업무 화면(견적·입고·차수표)을 만들어 줌 | 승인·알림·인수인계까지 메신저 하나로, 카톡 대체 |
| 포함 기능 | 데몬 설치(서명 EXE), 본인 대시보드(`/my-work`), 동의자 통합 뷰(`/orbit-one`·`/work-flow`), 내 수집 내역(`/my-privacy.html`), 업무 과정 지도, 승인형 자동화(엑셀·웹 API 1단계) | ①+ 업무 매뉴얼·절차 spec 자동 생성, 템플릿 ERP 모듈 2~3개(회사 데이터 매핑), 화면 생성 미리보기→승인 배포 | ②+ MOYI 앱(PC/iOS/Android), 승인 카드·업무카드·핸드오프, 카톡 브릿지(업무방) |
| 대상 고객 | 5~50인 사무직 중소기업, 대표가 "직원이 뭘 하는지·뭘 자동화할지" 알고 싶은 곳 | 엑셀+카톡으로 수입·유통·도매 업무를 돌리는 20~100인(네노바 유사 업종: 화훼·식자재·무역) | ②고객 중 카톡 업무방이 5개 이상이고 승인 흐름이 대표에게 몰리는 곳 |
| 가격 모델(제안) | 회사 기본 5만/월 + **PC당 1.9만/월** | 기본 15만/월 + **PC당 4.9만/월** + 구축비 1회(모듈당 100~300만) | 기본 20만/월 + **PC당 6.9만/월**(앱 사용자 무제한) |
| 가격 근거 | 비용 = 서버 저장(PC당 30일 보관)·비전 분석 호출 수가 PC 수에 비례 → PC 단위가 원가와 일치. 직원 수 ≠ PC 수(공용 PC·1인 2대) 이므로 **설치 대수 기준**, 동의자 수는 상한 없음 | ERP 는 회사 데이터 모델 매핑 수작업이 있어 구축비 분리. 월 단가는 데몬+ERP 호스팅 | 메신저는 사람 수가 많고 PC 없는 현장 인원도 씀 → 앱 사용자는 무과금, PC 기준 유지 |
| 현재 보유 자산 | 데몬 수집·자가복구 5중(DAEMON_STRUCTURE.md), 개인정보 게이트(src/privacy-gate.js), 본인 열람·열람 감사(`orbit_access_audit`), 대시보드 3종, 스크립트 생성 dry-run(routes/script-generator.js), rpa-runner | 네노바웹(nenova-erp-ui) 실운영 모듈, nenova-work-features(과정 체인·자가수정·절차 spec `build-process-specs.py`·업무 매뉴얼), 인보이스 골든 하네스 | talkhub(MOYI 앱·백엔드), MCP 도구(talkhub/MCP.md, 세션에 `moyi_*` 연결됨), nenovakakao 브릿지 |
| 부족 기능 | 셀프 초대·동의·철회 UI/DB, 테넌트 격리, 승인 기반 실행 계층, 서명 설치기, 과금 | 회사별 데이터 매핑 계층(현재 네노바 DB 스키마 직결), 화면 생성기(spec→페이지), 멀티테넌트 ERP 배포 | 나우링크 계정↔MOYI 계정 연결(SSO), 승인 카드의 결과 콜백, 테넌트별 MOYI 워크스페이스 |

### 1-2. 1단계 핵심: '동의받은 사람' 모델

목표 흐름:
```
관리자 초대(이메일/링크) → 직원 동의 화면(무엇을·어디까지·얼마나 보관) → 범위 선택
  범위 = {업무방(카톡방 목록), 앱(엑셀/ERP/브라우저 업무 도메인), 시간(근무시간대·요일)}
→ 데몬 설치(동의 토큰 포함) → 서버가 범위로 수집 판정 → 대시보드에 '동의자'로 표시
→ 철회(본인 버튼 1회) → 즉시 차단(다음 정책 갱신 ≤1시간 → 목표 5분) + 열람 중지 + 보관 데이터 삭제/익명화 선택
```

현재 커버 범위 vs 빈 곳:

| 단계 | 현재 (근거) | 빈 곳 |
|---|---|---|
| 초대 | 설치 링크 복사(사용자 토큰 포함, CLAUDE.md 완료 기능), `auto-register` | 이메일 초대·만료·수락 상태 없음 |
| 동의 | 설치 시 `consent`/`consentAt` 플래그를 auto-register 로 받아 기록(server.js:5766, 5828, 5919) — 체크 1개 수준 | 동의 문서 버전·항목별 동의·서명 기록 테이블 없음. 서면 동의는 종이(PRIVACY_POLICY.md) |
| 범위-업무방 | `workRooms` 목록(회사 공통, privacy-policy.json) | 개인별 범위 아님, 직원이 고를 수 없음 |
| 범위-앱 | `workDomains`·`messengerApps`(공통) | 개인별 선택 없음 |
| 범위-시간 | '개인 용무' 일시정지 30분/1시간(`/api/privacy/pause`) | 근무시간대 설정 없음(퇴근 후 수집 차단 규칙 없음) |
| 메신저 로컬추출 | `localExtraction.consentedUsers` 10명 — **관리자가 JSON 파일에 ID 수동 추가 후 배포** | DB·UI 아님, 회사 1개 전제(테넌트 구분 없음) |
| 열람 | 본인 열람 `/my-privacy.html`, 관리자 열람 감사 | 동의자끼리 "누가 내 것을 볼 수 있나" 권한 표 없음 |
| 철회 | "요청하면 명단에서 뺌"(PRIVACY_POLICY.md) — 사람 처리 | 셀프 철회 버튼·즉시 반영·데이터 처리 선택 없음 |
| 팀 공유 동의 | `/api/me/share-consent`(routes/personal-insights.js:184) — **메모리 Map, 재시작 시 초기화** | 영속화 필요 |

설계(첫 2주 ③): PG `nowlink_consents(workspace_id, user_id, doc_version, scope_json, granted_at, revoked_at, granted_by_ip)` → 데몬 정책 응답(`GET /api/daemon/privacy-policy`)을 workspace+user 별로 합성. 기존 privacy-policy.json 은 **회사 기본값**으로 남기고 개인 범위는 교집합으로만 좁힘(기존 동작 유지 + 추가).

### 1-3. 가격 산식 근거(가정 명시)
- 원가 축: 이벤트 저장(PC당 30일), 캡처 비전 분석(현재 관리자 PC CLI 야간 무과금 → 상용은 API 과금 필요, AGENT_GAP_AUDIT Top10 #10), Railway 메모리 768MB 단일 인스턴스(railway-cost-2026-10-12.md 참고).
- **미검증 가정**: PC당 일 캡처 분석 200장×Haiku 단가 수준이면 월 1만 원 미만 → Watch 1.9만은 마진 확보 가능. 실측(네노바 6~10대 한 달 API 비용)으로 확정 필요 — 로드맵 W3.

---

## 2. 2단계 '생성형 ERP' MVP

### 2-1. 현실적 경로(관찰→화면)
"화면을 처음부터 생성"이 아니라 **검증된 네노바웹 모듈을 템플릿으로, 관찰로 '어느 템플릿·어느 칸·어느 데이터'를 고르는 방식**.
```
관찰(데몬) → 과정 체인(nenova-work-features routine-extract/build-observed-workflows)
→ 절차 spec(build-process-specs.py: 화면·칸·값 출처) → 업무 매뉴얼
→ [매칭] spec 의 칸 라벨(차수/거래처/품목/수량/단가…)을 템플릿 모듈 필드와 대응
→ [매핑] 고객 데이터 원천(엑셀 시트·이카운트·기존 DB)을 템플릿 표준 스키마로 매핑 테이블 작성(사람 승인)
→ [생성] 템플릿 + 매핑 + 회사 용어(라벨명) → 페이지 생성 → 미리보기 → 승인 배포
```
근거: exe 원본해상도 캡처로 **칸 라벨은 정확**(WORK_MEMORY 10-14: 차수/거래처/품목명/공급가액 인식), 셀 값은 부정확 → 생성형 ERP 는 "라벨·구조"만 관찰에서 얻고 값은 원천 데이터에서 가져오는 설계가 맞다.

### 2-2. 네노바웹 모듈 템플릿화 판정

| 모듈 (nenova-erp-ui) | 템플릿화 | 이유 / 회사별 차이 |
|---|---|---|
| 견적 (`pages/estimate.js`) | **상** | 거래처·품목·수량·단가·공급가액·부가세 = 업종 공통. 차이는 단위(박스/단/송이) 환산 → 단위 환산표를 설정으로 |
| 입고 (`pages/incoming.js`) + 도착원가 (`pages/arrival-cost.js`) | **상** | 수입 유통 공통(인보이스→입고→원가). 차이: 운임·관세 배분 규칙 → 배분 규칙 선택형(수량/중량/금액) |
| 차수보드 (`pages/shipment/week-pivot.js` 등) | **중** | "주 단위 묶음" 자체는 일반화 가능(기간 단위 설정: 네노바=수~화). 호텔 차수 분리 등은 네노바 고유 |
| 작업대 | 중 | 직원별 할 일 목록 = 일반적, 원천이 회사마다 달라 매핑 비용 큼 |
| 매출이익 (`pages/sales/profit-report.js`) | 중하 | 선입선출 원가·재고 이월 규칙이 회사 회계 방식 의존 |
| 업무 드라이브 | 상(별도) | 파일 짝짓기(drive-pairs)는 공통, ERP 보다 MOYI 드라이브와 결합이 맞음 |

회사별 데이터 모델 차이 대응:
1. **표준 스키마 1벌**(거래처·품목·단위·기간·문서(견적/입고)·문서라인) + 회사별 `mapping.json`(원천 칸 → 표준 칸, 단위 환산, 기간 규칙).
2. 원천 3유형만 지원(MVP): 엑셀 업로드 / 이카운트 / 고객 자체 DB 읽기전용 뷰. 네노바는 기존 DB 직결 유지(nenova.exe 와 같은 DB — **쓰기 경로는 기존 네노바웹 그대로, 템플릿판은 읽기 전용부터**).
3. 쓰기(견적 생성 등)는 1단계 승인 실행 계층(P0-1)을 그대로 통과.

### 2-3. 첫 MVP 범위: 견적 · 입고(+도착원가) · 차수보드(읽기)
- 네노바 = 1호 고객 검증 계획:
  1. 템플릿판을 네노바 데이터에 매핑해 **기존 네노바웹 화면과 숫자 일치**(견적 합계·도착원가·차수별 수량) — 정답 = 기존 네노바웹/nenova.exe 화면, 엑셀 물량표.
  2. 3개 차수 × 3모듈 대조, 불일치 0 이 합격. 차수 데이터 대조는 `verify:week` 전후 검증 규칙 준수(읽기 전용이라 쓰기 없음).
  3. 두 번째 가상 회사(엑셀 원천, 다른 단위·다른 기간 규칙)로 mapping.json 만 바꿔 같은 화면이 뜨는지 확인 → 일반화 증거.
- 비범위: 매출이익·작업대·쓰기 기능 생성.

---

## 3. 3단계 MOYI 결합 — 연결점(신규 개발 최소)

| 나우링크 이벤트 | MOYI 출구(기존) | 비고 |
|---|---|---|
| 자동화 실행 승인 요청(P0-1 `planned`) | `moyi_request_approval` → 승인/거절 결과를 나우링크 `approve` API 로 콜백 | 승인자 ID·시각이 MOYI 계정으로 남음 = P0-2 감사로그 근거. 콜백 서명 필요 |
| 실행 결과·실패 알림 | `moyi_notify_user` / `moyi_notify_room` | 실패 시 담당자 지정 |
| 업무 인수인계(핸드오프) | `moyi_create_task_card` (+ `moyi_get_raci_matrix` 로 담당자 결정) | 과정 체인의 '다음 단계 담당자'를 카드로 |
| 업무카드/매뉴얼 공유 | `moyi_send_message` + MOYI 드라이브(`moyi_list_drive_files`) | 업무 드라이브 짝과 연결 |
| 카톡 업무방 원천 | nenovakakao 브릿지(MOYI Bridge, NENOVA_SOLUTION_AUDIT.md) | 개인정보 게이트 workRooms 와 동일 범위만 |

구현 형태: 서버 `src/moyi-outbox`(아웃박스 테이블 + 재시도) 1개로 위 호출을 모은다. talkhub 측은 기존 `POST /mcp/invoke`(talkhub/MCP.md) 재사용 — 테넌트별 MCP 토큰 저장만 추가. MOYI 작업은 PC/iOS/Android 3체계 표로 검증·보고.

---

## 4. 출시 준비 체크리스트 (P0 반영)

| # | 항목 | P0 | 현재 상태 (근거) | 할 일 | 규모 |
|---|---|---|---|---|---|
| 1 | 승인 API 구멍 | ●(P0-1/2) | **미완** — `/api/scripts` 인증 미들웨어 없이 마운트(server.js:8846), approve-run 호출만으로 `approved:true` 큐 투입(routes/script-generator.js:1169-1197) | 인증 필수, 승인자≠요청자, 상태 `approved` 아니면 409, 만료 30분 | S~M(3일) |
| 2 | 승인 기반 실행 계층 | ●(P0-1) | **미완** — 실행 0건 | `src/action-layer/` + `orbit_action_runs` 상태머신, 네노바웹 미확정 견적 1건 E2E | L(2~3주) |
| 3 | 실행 권한·감사로그 | ●(P0-2) | **미완** — 관리자 공유 토큰(DAEMON_STRUCTURE §5), audit-log 로컬 jsonl | 사용자별 토큰, PG append-only 감사 | M(1주) |
| 4 | 테넌트 격리 | ●(P0-3) | **부분** — `workspace_members`(src/db-pg.js:162) 있음, 그러나 하드코딩 ownerId(server.js:1742)·기본 이메일(script-generator.js:1200)·`dlaww584` 17곳 | 전 이벤트 `workspace_id` 강제, 교차조회 0 테스트 | L(2주) |
| 5 | 결과 검증 골든셋 | ●(P0-4) | **부분** — 인보이스 골든 27.6%(확정 53%) | 액션별 verify, 견적 1·주문 1 골든 | M |
| 6 | 원격 명령 안전 레일 | ●(P0-5) | **미완** — 명령 큐 TTL 없음, CodeSync `git reset --hard` 로 push=전 PC 배포 | TTL·서명·카나리 강제, 고객사 PC 는 릴리스 채널(태그) 고정 | M |
| 7 | 계정/과금 | ● | **미완** — Google OAuth 로그인만(src/auth-oauth.js), 과금 없음 | 회사 가입·PC 수 계량(heartbeat 기준)·결제(토스페이먼츠 정기결제 후보) | M~L |
| 8 | 서명 EXE 설치기 | ● | **미완** — PS 설치(install-open.ps1 irm, install.ps1), Defender 자가예외(admin), EXE 서명 미결 | 코드서명 인증서(OV/EV) 구매, MSI/Inno 패키징, AV 자가예외 제거 | M(인증서 발급 1~2주 포함) |
| 9 | nowlink.kr 도메인/인증서/다운로드 | ● | **부분** — 랜딩 운영 중(Next.js, Railway, Cloudflare NS, LE 인증서 ~2027-01-13 자동갱신), `/download` 404, 앱 서버는 여전히 `mindmap-viewer-production-adb2.up.railway.app` | `app.nowlink.kr`(서버)·`/download`(서명 EXE)·`/privacy` 연결. DNS 변경은 별도 승인 | S~M |
| 10 | 브랜드 교체(orbit→nowlink) | ○ | **미착수** — §6 실측: UI `Orbit` 807회, 전체 `orbit` 4,841회 | **노출 문자열만** 교체(HTML 타이틀·트레이 메뉴·설치 UI·랜딩). `~/.orbit`·`orbit_*` 테이블·schtasks `Orbit*` 이름은 유지(설치된 PC 호환) | M(노출분 1주) |
| 11 | 개인정보 처리방침 | ● | **부분** — 직원용 안내(PRIVACY_POLICY.md, public/privacy.html), 네노바 전용 문구(업무방 9개 실명) | 고객사용 처리방침·위탁계약(DPA)·동의서 템플릿, 회사별 정책 편집 | M(법무 검토 포함) |
| 12 | 동의 흐름(초대→철회) | ● | **부분** — §1-2 표 | 동의 테이블·초대/철회 API·UI | M |
| 13 | 보안 전반 | ● | **부분** — 개인정보 게이트·열람 감사 양호, 키 관리 문서 없음 | 비밀키 목록·회전 절차, 외부 점검 1회 | S~M |
| 14 | 지원 채널 | ○ | **미완** — 없음 | MOYI 고객 지원방 + 이메일(support@nowlink.kr) + 원격진단(`/api/admin/install-diag`) 고객별 화면 | S |

**P0(●) 12항목 중 완료 0 / 부분 6 / 미완 6.** (요청 기준의 P0 5개 축 = #2·#3·#4·#5·#6 → 완료 0, 부분 2, 미완 3)

---

## 5. 90일 로드맵 (2026-10-19 월 시작, 주 단위)

| 주 | 마일스톤 | 완료 기준 |
|---|---|---|
| W1 (10/19) | 승인 API 구멍 막기 + 감사로그 골격 | 무인증 403·미승인 409 테스트, 감사 1행 |
| W2 (10/26) | 테넌트 키 강제(비파괴, 기본 nenova) + 동의 테이블/API | 가짜 워크스페이스 교차조회 0, 동의·철회 API 테스트 |
| W3 (11/2) | 실행 계층: 네노바웹 미확정 견적 생성 dry-run→승인→실행→verify→취소 1회 | 실제 1건 + nenova.exe 동일 확인 + 롤백 로그. 비전 API 원가 실측 시작 |
| W4 (11/9) | **네노바 자체 검증 게이트 1**: 실행 5건 무사고, 승인은 MOYI 카드로 | 5/5 verify 통과 |
| W5 (11/16) | 코드서명 인증서 발급·MSI 패키징, 명령 큐 TTL·카나리 강제 | 서명 EXE 로 테스트 PC 설치, V3/Defender 무경고 |
| W6 (11/23) | 동의 UI(초대 메일·범위 선택·셀프 철회) + 노출 브랜드 nowlink 교체 | 직원 1명 초대→동의→철회 E2E |
| W7 (11/30) | app.nowlink.kr·/download·/privacy 연결(승인 후 DNS), 고객용 처리방침·DPA 초안 | 다운로드→설치→대시보드 신규 회사로 10분 내 |
| W8 (12/7) | **베타 1사 온보딩**(지인 기업 5~10PC, Watch) | 1주 데이터 수집·동의자 대시보드·교차노출 0 |
| W9 (12/14) | Build MVP: 표준 스키마 + mapping.json + 견적 템플릿(네노바 읽기) | 네노바 견적 합계 3차수 일치 |
| W10 (12/21) | 입고·도착원가 + 차수보드 템플릿 | 3모듈×3차수 불일치 0 |
| W11 (12/28) | 가상 2호사(엑셀 원천)로 매핑만 바꿔 동작 + 과금(PC 계량·정기결제) | 화면 생성 성공, 테스트 결제 |
| W12 (1/4) | 베타사 피드백 반영, 지원 채널 운영, 인증서 갱신 확인(1/13 만료 전) | 지원 응답 24h 이내 |
| W13 (1/11) | **유료 1사 계약**(베타사 전환 또는 신규) | 첫 청구 |

### 첫 2주 착수 항목(구체)
1. **승인 API 게이트** — `server.js:8846` `/api/scripts` 마운트에 인증(기존 `isAdminReqAsync` server.js:1782 재사용), `approve-run` 을 `generated_scripts.status='approved'` + `approved_by≠created_by` + 30분 만료 검사로 감싸기(기존 경로 삭제 X, 조건 미충족 409). 테스트: 무인증 403/미승인 409/정상 200.
2. **테넌트 키** — events·generated_scripts·orbit_daemon_commands 에 `workspace_id`(기본값 nenova 워크스페이스로 채움), server.js:1742·script-generator.js:1200 하드코딩을 요청자 워크스페이스로. `src/db.js`↔`src/db-pg.js` 동기화. 테스트: 가짜 워크스페이스 교차조회 0건.
3. **동의 레코드** — `nowlink_consents` + `POST /api/consent/invite|accept|revoke`, 정책 응답에 개인 범위 교집합 적용, privacy-policy.json `consentedUsers` 10명을 이관(파일은 폴백 유지). 테스트: `node tests/privacy-gate.check.js` 회귀 + 철회 후 정책 응답에서 제외.

---

## 6. 점검 결과 (읽기 전용, 2026-10-18 10:14 KST)

**nowlink.kr**
- `nslookup nowlink.kr` → A 69.46.46.124, NS = Cloudflare(arnold.ns.cloudflare.com 등).
- `curl -I https://nowlink.kr` → 200, `x-powered-by: Next.js`, `server: railway-hikari`, 제목 "나우링크 — 모든 사업장에 AI를 연결하다". `http://` → 301 https. `www.nowlink.kr` → 200.
- 인증서: Let's Encrypt(YR2), CN=nowlink.kr, 2026-10-15 ~ **2027-01-13**(Railway 자동갱신 추정 — 미검증).
- `/download` → 404. 앱 서버 서브도메인 미연결.
- 랜딩 저장소 위치는 이번에 특정 못함(로컬 repo 에서 '나우링크' 문자열 미검색) — **미확인**.

**하드코딩 집계** (mindmap-viewer, js/html/ps1/json/bat/css/py, node_modules·.git 제외, 대소문자 무시)
| 패턴 | 횟수 | 파일 |
|---|---|---|
| `orbit` 전체 | 4,841 | 370 |
| └ `Orbit`(대문자, html/js 노출 후보) | 807 | — (html 7개 파일) |
| └ `.orbit` 로컬 경로 | 446 | — |
| └ `orbit_*` PG 테이블/키 | 725 | — |
| └ ps1/bat 내 orbit(schtasks·경로) | 458 | — |
| `nenova` | 3,391 | 129 |
| `dlaww584`(관리자 이메일/토큰) | 17 | — |

해석: 교체 대상은 **노출 문자열(≈807 중 UI 문자열)** 위주. 내부 식별자(경로·테이블·작업 스케줄러 이름 ≈1,600+)는 설치된 PC 호환 때문에 유지. `nenova` 3,391 중 상당수는 1호 고객 고유 로직(앱키·업무방·도메인) → 테넌트 설정으로 빼낼 대상(P0-3).

## 미검증 / 남은 위험
- 가격은 제안값(원가 실측 전). 비전 API 원가 실측은 W3.
- `/api/scripts`: 마운트 줄·라우터 내부(`router.use` 없음) 모두 인증 미들웨어 없음 확인. 앞단 전역 미들웨어(app.use) 경유 여부만 남음.
- 랜딩 사이트 소스 저장소·배포 주체 미확인. DNS·인증서 변경은 하지 않았음.
