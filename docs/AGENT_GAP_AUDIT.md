# AGENT_GAP_AUDIT — 상용 '업무 에이전트 AI' 기준 Orbit 기능 격차 진단 (2026-10-18)

> **10줄 요약**
> 1. 관찰(지각)은 상용 수준에 근접(3.5/5): 화면·키보드·마우스·UIA·파일·업무카톡이 다 들어온다. 약점은 nenova.exe 내부 읽기(UIA 0, OmniParser로 76~82%) 하나.
> 2. 이해·계획은 '과정 지도' 단계(2.5/5, 2/5): 과정 신뢰도 평균 67, 일관 46. 아직 "다음에 이 칸에 이 값을 넣는다"를 확정하는 수준은 아님.
> 3. **실행이 가장 큰 구멍(1/5)**: 스크립트 생성·dry-run·`approve-run`·데몬 `rpa-runner`는 있지만, 승인자 확인·상태 게이트·결과 검증·롤백이 없고 실제 실행 0건.
> 4. `approve-run`은 호출만 하면 `approved:true`를 서버가 붙여 직원 PC 큐에 넣는다(routes/script-generator.js:1169-1197). 승인이 '사람 결정'이 아니라 'API 호출'이다 — 상용 출시 전 1순위 위험.
> 5. 검증(2/5): 인보이스 골든테스트 하네스는 있으나 실데이터 일치율 27.6%(확정 11쌍 53%). 실행 결과 검증은 없음.
> 6. 사람 협업(1.5/5): 승인 인박스·알림·"왜 이렇게 하는지" 설명 화면 없음.
> 7. 운영(2/5): 자가복구 5중은 강하지만 단일 회사(nenova) 하드코딩·관리자 토큰 공유·원격 명령 사고 이력. 멀티테넌시·서명 설치기 미결.
> 8. 신뢰·보안(2.5/5): 개인정보 게이트·본인 열람·열람 감사는 좋다. 실행 감사로그·권한 분리·키 관리가 빠짐.
> 9. P0 5개: ①승인 기반 실행 계층(웹 API·엑셀부터) ②실행 권한·감사로그 ③테넌트 격리 ④결과 검증 골든셋 ⑤원격 명령 안전 레일.
> 10. **첫 착수 추천: P0-1 승인 기반 실행 계층을 "nenovaweb 견적/주문 API 1건"에 붙여 end-to-end 1회 성공** — 되돌릴 수 있고, DB 기준 검증이 쉬움.

---

## 1. 축별 평가 (근거: 파일:줄 / 문서)

| 축 | 점수 | 있는 것 (근거) | 빠진 것 |
|---|---|---|---|
| 지각 | **3.5** | 수집 모듈 표 `DAEMON_STRUCTURE.md` §2(keyboard·screen·mouse·UIA work.step), 훅 차단 PC 폴백 §8-8, exe 원본해상도 캡처 `src/screen-capture.js _maybeExeFullRes`(WORK_MEMORY 2026-10-14) | nenova.exe UIA 히트 0 → 그리드 숫자 판독 불안정, 크롬 확장 강제설치 실패(UIA 대체 진행 중, 커밋 8c18507 등), `express.json 2mb`(server.js:468)로 큰 이미지 조용히 413 |
| 이해 | **2.5** | `nenova-work-features/routine-extract.js`(Leno·Dumas 루틴추출), 과정 신뢰도 59→67·일관 26→46(WORK_MEMORY 10-14), process-variants | 업무명이 사례키 없는 '모니터링' 등 잡음, 일관 상승 일부는 군집 정의 효과(자체 인정). 회사 업무 온톨로지(거래처·품목·차수)와 과정의 공식 연결 약함 |
| 기억 | **2.5** | PG events·flow-knowledge·kakao-ontology-sync(src/kakao-ontology-sync.js), 업무 드라이브 짝(drive-pairs, nenova-erp-ui PR #1050) | 직원별·회사별 '절차 지식 저장소'(버전·출처·승인 이력) 없음. 30일 보관(PRIVACY_POLICY.md)과 장기 학습 지식의 분리 정책 없음 |
| 계획 | **2** | `/api/scripts/from-session` dry-run 스크립트 생성(routes/script-generator.js:571-597, 664) | spec 표준 스키마(화면·필드·값 출처·사전조건·성공조건) 없음. 다음 행동 예측은 forecaster 에이전트 수준(문서), 코드상 실행 계획 없음 |
| 실행 | **1** | `approve-run`(script-generator.js:1169), 데몬 `rpa-run` 처리(src/daemon-updater.js:593), `src/rpa-runner.js`(dry-run 기본·BLOCK_PATTERNS·5분 타임아웃) | 실행 0건(gate cleared 0). 좌표 기반 pyautogui 위주 → 화면 바뀌면 오작동. 웹 API 실행 경로 없음. 사전조건 확인·중간 정지·롤백 없음 |
| 검증 | **2** | 인보이스 골든 하네스(invoice/golden.py, 27.6%/확정 53.1%), `tests/privacy-gate.check.js`, routes/autotest.js 주문 저장 dryRun | 실행 결과를 DB/화면으로 대조하는 사후검증 없음. 업무별 골든셋 1종뿐 |
| 사람 협업 | **1.5** | 관리자 대시보드(/admin-analysis.html), DM/채팅(routes/chat.js) | 승인 인박스, 실행 요청 알림(카톡/모바일), 계획 설명·근거 화면, 위임 단계(dry-run→부분자율→전권) 미구현(TOTAL_PLATFORM.md 08-03 기획만) |
| 자가학습 | **2** | 과정 체인 이력·자가수정 루프, capture-timing-learner(server.js:2063 근처) | 실행 실패→spec 수정 루프 없음(실행 자체가 없음). 학습 변경의 사람 검토 없음 |
| 운영 | **2** | 자가복구 5중·watchdog·codeVersion 텔레메트리(DAEMON_STRUCTURE.md §3-4, §6), 데몬 자동 업데이트 | 단일 테넌트 하드코딩(server.js:1742 ownerId, script-generator.js:1200 기본 이메일), 명령 큐 TTL 없음·워커/watchdog 경합(§5), 코드 push=전 PC 배포(CodeSync reset --hard), 서명 안 된 설치기, 비전 비용 모델(CLI 무과금 야간 vs API) 상용 부적합 |
| 신뢰·보안 | **2.5** | `src/privacy-gate.js`, 본인 열람 `/my-privacy.html`·`orbit_access_audit`, 로컬 추출(동의자만) | 관리자 토큰 1개 공유(§5 'config 토큰'), 실행 감사로그 없음(src/audit-log.js 는 로컬 jsonl·실행 미기록), `/api/scripts` 마운트에 라우트 단 인증 확인 안 보임(server.js:8846 — **미검증**, 전역 미들웨어 확인 필요), 키 관리(서비스계정·API키) 문서 없음 |

평균 ≈ **2.2 / 5** — "잘 보는 관찰 도구"이고 "일하는 에이전트"는 아직 아님.

## 2. 상용 고객이 첫 달에 막히는 지점 Top 10

1. **AI가 실제로 일을 하나도 안 한다** — 실행 0건. 데모 이후 "그래서 뭘 대신해줬나"에 답 없음.
2. **승인이 누가 했는지 안 남는다** — approve-run 이 승인자·상태 검사 없이 큐 투입. 고객 보안팀 심사 탈락 사유.
3. **설치가 보안 SW에 막힌다** — 서명 없는 PS 설치기, AV 예외 자가등록(관리자 권한) → 일반 기업은 IT정책상 불가.
4. **회사 하나만 가정** — ownerId·이메일·nenova 앱키 하드코딩. 2번째 고객 온보딩 시 데이터 섞임 위험.
5. **사내 프로그램(데스크톱 ERP) 읽기 실패** — UIA 0인 앱은 OCR 정확도 76~82%, 숫자 칸 오독.
6. **직원 반발·법무 질문** — 동의서 양식·보관기간·열람기록은 있으나 고객사별 정책 편집 UI·DPA 템플릿 없음.
7. **"이 과정 맞나?" 판단 불가** — 과정 신뢰도 67, 근거 화면이 엔지니어용.
8. **알림이 없다** — 승인 대기/실패를 담당자가 모른다.
9. **원격 명령 사고** — 한 번의 push/명령이 전 PC에 반영(카나리 규칙은 사람 규율뿐, 시스템 강제 아님).
10. **비용·용량 예측 불가** — 비전 분석이 관리자 PC CLI 야간 워커 의존, 고객 규모별 단가 없음.

## 3. 보완 로드맵

### P0 (상용 출시 필수)

**P0-1 승인 기반 실행 계층 (Action Layer)** — 규모 L(2~3주)
- 흐름: `plan(dry-run 미리보기: 대상·변경 전/후 diff)` → `사람 승인(승인자 ID·시각·만료 30분)` → `실행(멱등키)` → `검증(DB/응답 재조회로 성공조건 확인)` → `실패 시 보상(롤백) 또는 정지` → 전 단계 감사로그.
- 대상 순서: ①nenovaweb API(견적·주문 생성 — 소프트삭제/취소 API로 되돌림 가능) ②엑셀 파일(원본 보존 후 사본 수정) ③데스크톱 UI(pyautogui)는 P1.
- 어디: 새 `src/action-layer/`(actions 레지스트리: `{id, target:'nenovaweb'|'excel', preconditions, apply, verify, compensate}`), PG `orbit_action_runs`(상태머신 planned→approved→running→verified|failed|rolled_back), 기존 `routes/script-generator.js:1169 approve-run` 은 이 계층을 거치도록 감싼다(기존 경로 삭제 X, 상태 `approved` 아니면 409).
- 완료 기준: 실제 주문/견적 1건이 승인→생성→nenova.exe 에서 동일 확인→취소 롤백까지 1회 성공, 로그 1행씩 남음. 승인 없이 호출 시 409 테스트 통과.
- 위험: nenovaweb 는 nenova.exe 와 같은 DB — 확정·출고분배 후속 단계 막힘(사용자 판단기준). → 첫 대상은 '미확정 견적'으로 한정, 테스트 거래처 사용.

**P0-2 권한·감사로그** — M(1주)
- 역할 분리(requester/approver/executor), 자기 요청 자기 승인 금지, 관리자 공유 토큰 → 사용자별 토큰. 감사로그는 PG append-only(`orbit_action_audit`, 해시체인).
- 어디: `src/audit-log.js`(로컬 jsonl → PG 동기), `server.js:1782 isAdminReqAsync`, `/api/scripts` 마운트 인증 확인(server.js:8846).
- 완료: 무권한 approve-run 403, 감사 조회 API, 변조 감지 테스트.

**P0-3 테넌트 격리** — L(2주)
- 모든 이벤트·과정·액션에 `workspace_id` 강제, 하드코딩 owner/이메일 제거(server.js:1742, script-generator.js:1200), 데몬 등록 시 테넌트 바인딩.
- 완료: 2번째 가짜 워크스페이스로 교차조회 0건 테스트. 위험: 기존 nenova 데이터 마이그레이션 — 기본값 nenova 로 채우는 비파괴 방식.

**P0-4 결과 검증 골든셋** — M(1~2주)
- 액션마다 `verify()` + 업무별 골든 케이스(주문 1·견적 1·인보이스 확정 11쌍). CI 에서 실행.
- 완료: 액션 레지스트리 항목 100%가 verify 보유, 골든 리포트 자동 생성.

**P0-5 원격 명령 안전 레일** — M(1주)
- 명령 큐 TTL·서명, 카나리 1대 → 비율 확대를 시스템이 강제, 워커/watchdog 큐 경합 해소(DAEMON_STRUCTURE.md §5), `exec` 액션 화이트리스트.
- 완료: 만료 명령 미실행, 카나리 미통과 시 확대 차단 테스트.

### P1
- 승인 인박스 + 알림(모바일/카톡 링크, 계획 설명·근거·confidence 배지) — `/admin-analysis.html` 옆 새 페이지. M
- 표준 task spec 스키마(화면·필드·값 출처·사전/성공조건) + from-session 이 spec 생성 → 액션으로 승격. M
- 엑셀 실행기(원본 보존, 셀 diff 미리보기). M
- 데스크톱 UI 실행: OmniParser 원본해상도 + 앵커 텍스트 기반 클릭(좌표 고정 금지), 단계별 화면 확인. L
- 서명된 설치기(MSI/코드서명), AV 자가예외 제거. M
- 실행 실패→spec 수정 제안 루프(사람 검토 후 반영). M

### P2
- 위임 단계(dry-run→부분자율: 고신뢰 액션 자동→전권), 고객사 정책 편집 UI·DPA 템플릿, 비용 계량(테넌트별 비전 호출·저장량), 지식 저장소 버전관리, 다음 행동 예측 실시간화.

## 4. 첫 착수 추천
**P0-1 을 nenovaweb '미확정 견적 생성' 1건에 적용.** 이유: 되돌릴 수 있음(취소/삭제), 정답을 DB·nenova.exe 로 바로 대조 가능, 인증·감사(P0-2)의 최소 골격을 함께 만들게 됨. 착수 전 결정 필요: 테스트 거래처 지정, 승인자(사장님 단독 vs 팀장).

## 미검증
- `/api/scripts` 전역 인증 미들웨어 여부(라우트 내 검사만 확인).
- 실행 0건·gate cleared 0 은 메모리/상위 세션 기준, 이번에 DB 재조회 안 함(DB 접근 금지 범위).
