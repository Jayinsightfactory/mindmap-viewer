# Work Memory

이 파일은 대화에서 나온 핵심 지시, 반복 수정 요청, 이미 해결한 오류를 잃지 않기 위한 작업 기억장치입니다.

새 작업을 시작할 때는 관련 단어를 먼저 검색하고, 작업 후에는 이 파일에 요약을 추가합니다.
삭제하지 말고 날짜별로 누적합니다.

## 최우선 원칙

- 대화 내용과 사용자의 반복 지시는 삭제하거나 덮어쓰지 않습니다.
- 새 기능을 만들기 전에 관련 단어를 `rg`로 먼저 검색합니다.
- 사용자가 "전에 말한 것", "또 반복된다", "적용이 안 됐다"라고 하면 구현보다 원인 진단을 먼저 합니다.
- 이미 만든 기능을 새로 만드는 대신, 기존 코드와 커밋이 왜 작동하지 않았는지 확인합니다.
- 작업이 끝나면 변경 파일, 검증 결과, 남은 리스크를 기록합니다.

## 작업 전 검색 규칙

작업 전 최소 검색 대상:

```powershell
scripts/prework-search.ps1 "검색어1" "검색어2"
```

수동으로 할 때는 다음 파일과 폴더를 먼저 봅니다.

```powershell
rg -n --ignore-case "검색어" WORK_MEMORY.md WORKSPACE.md PROGRESS.md CLAUDE.md README.md docs public routes src nenova-erp-ui scripts
```

검색해야 하는 단어 예시:

| 주제 | 검색어 |
|------|--------|
| Nenova ERP | `nenova`, `nenovaweb`, `erp`, `주문`, `재고`, `거래처`, `출고`, `입고`, `차수` |
| 카카오 자동화 | `kakao`, `카카오`, `카톡`, `미러`, `room`, `gsheet`, `Google Sheet` |
| 반복 오류 | `반복`, `또`, `미적용`, `누락`, `fix`, `bug`, `TODO`, `남은 작업` |
| 배포/원격 | `origin`, `dlaww-wq`, `Jayinsightfactory`, `Railway`, `main` |

## 반복 오류 방지 절차

1. `git log --oneline -30`으로 이미 처리한 커밋을 확인합니다.
2. 관련 단어를 `WORK_MEMORY.md`, `WORKSPACE.md`, `PROGRESS.md`, `CLAUDE.md`, 코드 전체에서 검색합니다.
3. 기존 구현 위치를 찾습니다.
4. 작동하지 않는 이유를 분류합니다.
   - 미배포
   - 연결 누락
   - 데이터/환경 변수 누락
   - 기존 코드와 새 코드의 중복/충돌
   - 실제 버그
5. 최소 수정만 합니다.
6. 검증 명령을 실행합니다.
7. 이 파일에 결과를 추가합니다.

## 핵심 사용자 지시

### 2026-05-24 KST

- GitHub가 흩어져 있으면 하나로 정리해야 합니다.
- `dlaww-wq`는 삭제된 저장소이므로 사용하지 않습니다.
- 기준 저장소는 `Jayinsightfactory/mindmap-viewer`입니다.
- 사용자는 하나의 페이지에서 여러 작업을 동시에 하는 경우가 있습니다.
- 그래서 작업 단위는 "페이지"가 아니라 업무 흐름, 패널, 탭, 상태 카드, 도메인으로 봅니다.
- 대화 내용과 이전 수정 요청이 삭제되면 안 됩니다.
- 작업할 때는 관련 단어를 먼저 검색해야 합니다.
- 매번 수정해달라고 했던 것이 적용되지 않아 같은 오류가 반복되는 일을 막아야 합니다.

## 현재 통합 상태

### 2026-05-24 KST

- `origin`은 `https://github.com/Jayinsightfactory/mindmap-viewer.git` 하나로 정리했습니다.
- `dlaww-wq` 원격은 제거했습니다.
- `nenova-erp-ui/`는 기준 저장소 `main`에 통합했습니다.
- PR `#4 Unify Nenova ERP UI workspace`가 squash merge 되었습니다.
- `WORKSPACE.md`에 흩어진 저장소 정리 방향을 기록했습니다.

## 반복 수정 요청 기록

### Nenovaweb 첫 화면 내용 부족

날짜:
- 2026-05-24 KST

사용자 요청:
- `nenovaweb` 첫 페이지가 메뉴만 있고 중요한 내용이 없으므로, 기존 메뉴와 기능은 유지하면서 transcript 기반 구성 기획을 추가해야 합니다.
- 700개가 넘는 녹음, 견적서 자동 발행, 계약 후 프로젝트 생성, 할 일 배정, 일정 보고, 명함 OCR, 매출/세금계산서, Slack/Kakao 알림, Claude/GPT 업무 질의 구조를 반영해야 합니다.
- 회사 직원들이 Claude API와 GPT API를 사용해서 질문하고 답하면서 업무를 볼 수 있어야 합니다.

검색한 단어:
- `nenovaweb`, `첫페이지`, `메뉴`, `Claude`, `GPT`, `API`, `녹음`, `견적`

현재 조치:
- `nenova-erp-ui/src/app/(app)/dashboard/page.tsx`를 운영 허브 첫 화면으로 확장했습니다.
- `nenova-erp-ui/src/app/(app)/assistant/page.tsx`를 추가했습니다.
- `nenova-erp-ui/src/app/api/assistant/route.ts`를 추가해 Claude/GPT 서버 라우팅 구조를 만들었습니다.
- `nenova-erp-ui/src/components/AiWorkConsole.tsx`를 추가했습니다.
- `nenova-erp-ui/src/lib/operating-plan.ts`에 transcript 기반 운영 모듈을 정리했습니다.

검증:
- `npm run build` 성공
- 브라우저 로그인 후 `/dashboard`에서 운영 허브, AI 비서, 녹음/견적/프로젝트 흐름, 최근 주문 표시 확인
- `/assistant`에서 질문 실행 후 데모 응답 표시 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/dashboard/page.tsx`
- `nenova-erp-ui/src/app/(app)/assistant/page.tsx`
- `nenova-erp-ui/src/app/api/assistant/route.ts`
- `nenova-erp-ui/src/lib/operating-plan.ts`

### 저장소/작업 기준 반복

문제:
- GitHub 저장소가 여러 개라 작업 위치가 흩어져 보였습니다.
- 예전 `dlaww-wq` 원격이 남아 있어 기준이 헷갈렸습니다.

현재 조치:
- 로컬 원격은 `origin = Jayinsightfactory/mindmap-viewer`만 남겼습니다.
- `WORKSPACE.md`에 기준 저장소와 흡수 대상 저장소를 기록했습니다.

다음 작업자가 지켜야 할 것:
- 새 작업은 `Jayinsightfactory/mindmap-viewer`에서 시작합니다.
- 예전 저장소를 새 기준처럼 사용하지 않습니다.
- 흩어진 저장소는 참고 소스로만 보고 필요한 코드만 선별 흡수합니다.

### 반복 요청 미적용 방지

문제:
- 사용자가 반복해서 수정 요청을 했는데 기존 코드에 반영되지 않거나, 반영됐어도 연결/배포가 빠져 다시 같은 문제가 생겼습니다.

현재 조치:
- `CLAUDE.md`와 이 파일에 작업 전 검색, 원인 진단, 메모리 업데이트 규칙을 명시합니다.
- `scripts/prework-search.ps1`로 관련 단어 검색을 빠르게 실행할 수 있게 합니다.

다음 작업자가 지켜야 할 것:
- 바로 새로 만들지 말고 검색부터 합니다.
- 수정 후에는 실제 실행/빌드/라우트 확인까지 합니다.
- 작업 결과는 이 파일에 날짜별로 누적합니다.

### KakaoWork 기반 회사 업무 연동

날짜:
- 2026-05-24 KST

사용자 요청:
- 회사 업무는 카카오워크 기반으로 보게 되므로, KakaoWork API와 연동되는 `nenovaweb` 구조의 기초 설계가 필요합니다.
- 단순 알림이 아니라 카카오워크 대화에서 업무 요청, 질문, 승인, 완료 보고가 들어오고 `nenovaweb` 업무 데이터로 이어져야 합니다.

검색한 단어:
- `카카오워크`, `KakaoWork`, `messages.send`, `conversations.open`, `webhook`, `워크 API`

기존 코드에서 찾은 것:
- `routes/issues.js`: `KAKAOTALK_TOKEN`, `KAKAO_ADMIN_CONV_ID`, `messages.send`, `conversations.open` 기반 알림
- `routes/automation-engine.js`: 입고 예정 변경 감지 후 KakaoWork 관리자 채널 알림
- `routes/webhooks.js`: 수신 웹훅 기록/정규화 패턴

현재 조치:
- `nenova-erp-ui/src/app/(app)/kakaowork/page.tsx`를 추가해 카카오워크 업무 게이트 설계를 화면화했습니다.
- `nenova-erp-ui/src/lib/kakaowork-plan.ts`에 흐름, API 계약, 데이터 매핑, 환경변수, 보안 체크를 정리했습니다.
- `nenova-erp-ui/src/app/api/kakaowork/notify/route.ts`를 추가해 dryRun/live 메시지 발송 기반을 만들었습니다.
- `nenova-erp-ui/src/app/api/kakaowork/callback/route.ts`를 추가해 수신 이벤트 정규화 기반을 만들었습니다.
- `docs/nenova-kakaowork-integration.md`에 공식 API 기준과 단계별 구현 계획을 기록했습니다.

검증:
- `npm run build` 성공
- `GET /api/kakaowork/notify` 응답 확인
- `POST /api/kakaowork/notify` dryRun 응답 확인
- `POST /api/kakaowork/callback` 정규화 응답 확인
- 브라우저에서 `/kakaowork` 메뉴, 제목, 업무 흐름, API 설계 표시 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/kakaowork/page.tsx`
- `nenova-erp-ui/src/app/api/kakaowork/notify/route.ts`
- `nenova-erp-ui/src/app/api/kakaowork/callback/route.ts`
- `nenova-erp-ui/src/lib/kakaowork-plan.ts`
- `docs/nenova-kakaowork-integration.md`

### ERP 흐름 실제 기능화

날짜:
- 2026-05-24 KST

사용자 요청:
- 대시보드/AI 비서가 기획 수준을 넘어서 실제 ERP 기준으로 기능 구현되었으면 좋겠다고 요청했습니다.

검색한 단어:
- `nenova`, `erp`, `견적`, `계약`, `프로젝트`, `할 일`, `일정`, `매출`, `세금계산서`

기존 상태:
- `nenova-erp-ui/src/lib/store.ts`에는 주문/재고/고객 CRUD만 있었습니다.
- 녹음, 견적, 계약, 프로젝트, 할 일, 매출/세금계산서는 `operating-plan.ts`와 대시보드 표시 수준이었습니다.

현재 조치:
- `store.ts`에 회의/녹음 기록, 견적, 프로젝트, 할 일, 세금계산서, 일일 보고 타입과 저장/전환 로직을 추가했습니다.
- `/erp-flow` 화면을 추가했습니다.
- 회의 기록 → 견적 생성 → 계약 확정 → 프로젝트/할 일/세금계산서 생성 흐름을 실제 버튼 동작으로 만들었습니다.
- 프로젝트 진행률, 할 일 상태, 세금계산서 상태, 일일 보고 생성 기능을 추가했습니다.
- 대시보드가 실제 ERP 스냅샷 지표를 표시하게 했습니다.
- AI 업무 콘솔이 현재 ERP 스냅샷을 함께 보내도록 연결했습니다.

검증:
- `npm run build` 성공
- 브라우저에서 `/erp-flow` 주요 섹션 표시 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/erp-flow/page.tsx`
- `nenova-erp-ui/src/lib/store.ts`
- `nenova-erp-ui/src/app/(app)/dashboard/page.tsx`
- `nenova-erp-ui/src/components/AiWorkConsole.tsx`

### Claude 에이전트 검증 + 직원 작업 단위 3차 교차검증

날짜:
- 2026-05-24 KST

사용자 요청:
- Claude에서도 서로 검증하는 에이전트 구성을 만들고, `nenova.exe` 직원 작업 단위를 네노바웹에서 확인할 수 있게 해야 합니다.
- 직원마다 계정과 작업 영역이 다르므로 계정별 업무영역을 체크해야 합니다.
- 클릭/작업 시간대와 카카오톡/카카오워크 대화를 매칭해서, 어떤 대화가 어떤 작업을 만들었는지와 어떤 작업 뒤 어떤 톡이 오갔는지를 양방향으로 확인해야 합니다.
- PC 작업 데이터까지 합쳐 3차 교차검증해야 합니다.

검색한 단어:
- `Claude`, `클로드`, `에이전트`, `agent`, `검증`, `verification`, `process-mining`, `employee`, `work unit`, `작업단위`, `nenova.exe`, `KakaoTalk`, `KakaoWork`

기존 구현 확인:
- `.claude/agents/`에 일반 작업 에이전트는 있었지만 Nenova 전용 데이터 병합/예측/교차검증 에이전트는 없었습니다.
- `routes/process-mining.js`에는 세션/블록 병합 기준이 있었습니다.
- `nenova-erp-ui`에는 ERP 흐름은 있었지만 직원 계정별 작업 단위, 카카오 대화 전후관계, PC 클릭 근거를 함께 보는 화면은 없었습니다.

현재 조치:
- Claude 에이전트 4개를 추가했습니다: `nenova-data-fusion`, `nenova-workflow-forecaster`, `nenova-cross-validator`, `nenova-ops-orchestrator`.
- `/work-units` 화면을 추가해 직원 계정, 업무영역, 클릭/PC 근거, 카카오톡/워크 대화 매칭, 3차 검증 상태를 확인하게 했습니다.
- `store.ts`에 `WorkUnit`, `TalkEvent`, `TalkWorkRelation`, `CrossValidationStatus` 타입과 샘플 데이터, 스냅샷 함수를 추가했습니다.
- `POST /api/work-units`를 추가해 `nenova.exe`가 작업 이벤트를 보낼 수 있는 기초 API를 만들었습니다.
- 대시보드에 작업 단위 지표와 `/work-units` 링크를 추가했습니다.
- AI 비서 프롬프트에 계정별 업무영역, 클릭/작업 시간대, 카카오톡/워크 대화, PC 화면/앱 데이터를 3차 교차검증하도록 지시를 추가했습니다.
- `docs/nenova-claude-agent-orchestration.md`, `docs/nenova-work-unit-cross-validation.md`에 운영 설계를 기록했습니다.

검증:
- `npm run build` 성공
- `git diff --check` 통과
- `GET /work-units` HTTP 200 확인
- `GET /api/work-units` 응답 확인
- 브라우저에서 `/work-units` 주요 문구, 계정 ID, 카카오 대화 매칭, 3차 검증 섹션 표시 확인
- 브라우저에서 `/dashboard` 작업 단위 메뉴/지표/링크 표시 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`
- `nenova-erp-ui/src/app/api/work-units/route.ts`
- `nenova-erp-ui/src/lib/store.ts`
- `nenova-erp-ui/src/app/api/assistant/route.ts`
- `.claude/agents/nenova-ops-orchestrator.md`
- `.claude/agents/nenova-cross-validator.md`
- `docs/nenova-work-unit-cross-validation.md`

추가 조치:
- `POST /api/work-units`를 메모리 배열에서 파일 저장형 수신함으로 변경했습니다.
- 수신 데이터는 `nenova-erp-ui/data/work-units.json`에 저장하며, 운영 데이터라 Git 추적에서 제외했습니다.
- `/work-units` 화면이 localStorage 시드 데이터와 API 수신 데이터를 병합해 표시합니다.
- `scripts/post-work-unit-sample.ps1` 샘플 전송 스크립트를 추가했습니다.
- PowerShell 5.1 인코딩 문제 때문에 실행용 PS1은 ASCII 페이로드로 유지하고, 한글 페이로드 예시는 `docs/nenova-exe-work-unit-ingest.md`에 문서화했습니다.
- API는 영어 relation 값(`talk_before_work`, `work_before_talk`, `simultaneous`)도 한국어 검증 관계로 정규화합니다.

추가 검증:
- `npm run build` 성공
- `scripts/post-work-unit-sample.ps1` 실행 후 `GET /api/work-units`에서 수신 1건, `대화후작업`, `부분일치` 확인
- `/work-units` HTTP 200 확인

### Process Mining → 작업 단위 브릿지

날짜:
- 2026-05-24 KST

현재 조치:
- `routes/process-mining.js`의 분석 이벤트 타입에 `mouse.chunk`를 추가했습니다.
- `buildActivityBlocks`가 클릭 수와 클릭 근거를 유지하도록 확장했습니다.
- `GET /api/mining/work-units`를 추가해 PC/recorder/process-mining 이벤트를 네노바웹 작업 단위 후보로 변환합니다.
- `POST /api/mining/work-units/push`를 추가해 후보를 `NENOVA_WORK_UNITS_URL` 또는 `http://localhost:3000/api/work-units`로 전송합니다.
- 30분 창 안의 KakaoTalk 이벤트를 `relatedTalks`로 묶고 `대화후작업`, `작업후대화`, `동시진행`으로 분류합니다.

검증:
- `node --check routes/process-mining.js` 성공
- `node --check server.js` 성공
- `npm run build` 성공

다시 반복되면 먼저 볼 위치:
- `routes/process-mining.js`
- `docs/nenova-exe-work-unit-ingest.md`

### KakaoWork 콜백 → 작업 단위 후보 등록

날짜:
- 2026-05-24 KST

현재 조치:
- `POST /api/kakaowork/callback`이 이제 수신 이벤트를 `nenova-erp-ui/data/kakaowork-events.json`에 저장합니다.
- 콜백 수신 시 기본적으로 `/api/work-units`에 `KakaoWork` 작업 단위 후보를 자동 등록합니다.
- `syncWorkUnit: false`를 보내면 콜백 이벤트만 저장하고 작업 단위 등록은 생략합니다.
- 카카오워크 메시지 텍스트에서 견적/계약/프로젝트/할 일/재고/정산/보고/AI검토 의도를 1차 추론합니다.
- 명시적으로 `talkRelation: "미연결"`이 들어온 작업 단위는 같은 시각 대화가 있어도 `동시진행`으로 강제 추론하지 않도록 고쳤습니다.

검증:
- `npm run build` 성공
- 샘플 `POST /api/kakaowork/callback` 성공
- `GET /api/work-units`에서 `KW-WU-kw-msg-sample-001` 후보가 `미연결`/`검증대기`로 저장되는 것 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/kakaowork/callback/route.ts`
- `nenova-erp-ui/src/app/api/work-units/route.ts`
- `docs/nenova-kakaowork-integration.md`

### 직원 계정 매핑 기준

날짜:
- 2026-05-24 KST

현재 조치:
- `nenova-erp-ui/src/lib/employee-directory.ts`를 추가해 내부 직원 계정, 팀, 기본 업무영역, 이메일, KakaoWork userId, Orbit userId, PC hostname, 별칭을 한 곳에 모았습니다.
- `GET /api/employees/directory`를 추가해 매핑 상태와 단건 해석 결과를 확인할 수 있게 했습니다.
- `/api/kakaowork/callback`과 `/api/work-units`가 이 매핑을 사용해 외부 ID를 내부 `accountId`로 정규화합니다.
- `/work-units` 카드에 `계정매핑 {근거} {신뢰도}%` 배지를 추가했습니다.
- 샘플 `worker@example.com`/`kw-user-001`은 `설연주`, `seol`, `nenova:sales-support:sul-yeonju`, `견적/거래처 단가`로 해석됩니다.

검증:
- `npx tsc --noEmit` 성공
- `GET /api/employees/directory?userEmail=worker@example.com` 확인
- 카카오워크 샘플 콜백 재전송 후 `/api/work-units`에서 내부 계정으로 저장 확인
- `/work-units` HTTP 200 확인

주의:
- `npm run build`는 코드 타입 체크 전 단계에서 `.next/server/app/assistant.segments` 파일 잠금(OneDrive/Next dev 산출물)으로 실패했습니다. 같은 변경에 대해 `npx tsc --noEmit`과 dev 서버 HTTP 200으로 대체 검증했습니다.

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/lib/employee-directory.ts`
- `nenova-erp-ui/src/app/api/employees/directory/route.ts`
- `nenova-erp-ui/src/app/api/kakaowork/callback/route.ts`
- `nenova-erp-ui/src/app/api/work-units/route.ts`

### KakaoWork → ERP 수신함

날짜:
- 2026-05-24 KST

현재 조치:
- `GET/POST/PATCH /api/erp/intake`를 추가했습니다.
- 카카오워크 콜백에서 견적/할 일/재고/정산/프로젝트 의도가 나오면 ERP 수신함에 초안으로 자동 저장합니다.
- `/erp-flow`에 "카카오워크 ERP 수신함" 섹션을 추가했습니다.
- 수신함 항목을 회의/견적 후보 또는 할 일로 전환하고, 보류/초안 복귀를 할 수 있게 했습니다.

검증:
- `npx tsc --noEmit` 성공
- 샘플 KakaoWork 콜백이 `ERP-IN-KW-kw-msg-sample-erp-001` 견적 초안으로 들어오는 것 확인
- `/erp-flow` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/erp/intake/route.ts`
- `nenova-erp-ui/src/app/api/kakaowork/callback/route.ts`
- `nenova-erp-ui/src/app/(app)/erp-flow/page.tsx`

### ERP 수신함 전환 추적

날짜:
- 2026-05-24 KST

현재 조치:
- `/api/erp/intake`의 PATCH가 `linkedEntityType`, `linkedEntityId`, `convertedAt`, `conversionNote`를 저장합니다.
- `/erp-flow`에서 수신함 항목을 회의/견적 후보나 할 일로 전환하면 생성된 localStorage ERP 객체 ID를 서버 수신함에 다시 연결합니다.
- 전환된 수신함 카드에는 `연결 meeting MTG-...` 또는 `연결 task TSK-...`가 표시됩니다.

검증:
- `npx tsc --noEmit` 성공
- `POST /api/erp/intake` 후 `PATCH /api/erp/intake`로 `linkedEntityId`와 `convertedAt` 저장 확인
- `/erp-flow` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/erp/intake/route.ts`
- `nenova-erp-ui/src/app/(app)/erp-flow/page.tsx`

### ERP 수신함 초안 필드 추출

날짜:
- 2026-05-24 KST

현재 조치:
- `/api/erp/intake`가 카카오워크/외부 메시지에서 고객, 공급가, 목표일을 1차 추출합니다.
- 지원 예시는 `대한상사에서 견적 320만원 내일까지`, `고객사: ...`, `1,200,000원`, `1.5억`, `5월 30일`, `D+3`, `다음주 금요일`입니다.
- 추출 결과는 `customer`, `amount`, `dueDate`에 저장되고 evidence에 `extracted_customer`, `extracted_amount`, `extracted_dueDate`가 남습니다.
- `/erp-flow` 수신함 카드에 추출된 고객/공급가를 표시합니다.
- 견적 수신함 항목에 `amount`가 있으면 전환 시 회의 기록뿐 아니라 견적 초안까지 생성하고 `linkedEntityType: "quote"`로 연결합니다.

검증:
- `npx tsc --noEmit` 성공
- 샘플 카카오워크 콜백 `대한상사에서 견적 320만원 내일까지 부탁드립니다.`가 `customer=대한상사`, `amount=3200000`, `dueDate=2026-05-25`로 저장되는 것 확인
- `/erp-flow` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/erp/intake/route.ts`
- `nenova-erp-ui/src/app/(app)/erp-flow/page.tsx`

### KakaoWork 액션 → ERP 수신함 상태 변경

날짜:
- 2026-05-24 KST

현재 조치:
- `GET/POST /api/kakaowork/action`을 추가했습니다.
- 카카오워크 버튼/액션 payload의 `action`과 `intakeId`를 받아 `/api/erp/intake` 상태를 바꿉니다.
- 지원 액션은 `approve -> 승인완료`, `hold -> 보류`, `restore -> 초안`, `convert -> 승인완료 + requestedConversionAt`입니다.
- 액션 실행자는 직원 디렉터리로 `accountId`까지 매핑하고 `lastAction`에 저장합니다.
- `/api/kakaowork/callback`도 `actions.action`과 `actions.intakeId`를 감지하면 `/api/kakaowork/action`으로 전달합니다.
- `/erp-flow` 수신함 카드에 마지막 카카오워크 액션을 표시합니다.

검증:
- `npx tsc --noEmit` 성공
- `GET /api/kakaowork/action` 계약 응답 확인
- 직접 `POST /api/kakaowork/action` convert 성공
- `POST /api/kakaowork/callback`의 actions payload가 action route로 전달되어 보류 처리되는 것 확인
- `/erp-flow` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/kakaowork/action/route.ts`
- `nenova-erp-ui/src/app/api/kakaowork/callback/route.ts`
- `nenova-erp-ui/src/app/api/erp/intake/route.ts`
- `nenova-erp-ui/src/app/(app)/erp-flow/page.tsx`

### Work Unit ↔ ERP Intake 병합 후보

날짜:
- 2026-05-24 KST

현재 조치:
- `GET /api/work-units/intake-candidates`를 추가했습니다.
- file-backed `work-units.json`과 `erp-intake.json`을 비교해 같은 카카오워크 이벤트, 내부 계정, 카테고리, 고객, 시간창, ERP 연결 여부로 점수화합니다.
- `/work-units`에 "ERP 수신함 병합 후보" 섹션을 추가했습니다.
- 후보 카드에는 작업 단위, ERP 수신함, 점수, 추천(`자동 병합 후보`/`검토 후 병합`), 근거 태그가 표시됩니다.

검증:
- `npx tsc --noEmit` 성공
- `GET /api/work-units/intake-candidates` 응답 확인
- 같은 KakaoWork event/account/category 샘플이 89점 `자동 병합 후보`로 잡히는 것 확인
- `/work-units` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/work-units/intake-candidates/route.ts`
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`
- `docs/nenova-work-unit-cross-validation.md`

### ERP Flow 전환 요청 큐 표시

날짜:
- 2026-05-24 KST

현재 조치:
- `/erp-flow` 카카오워크 ERP 수신함에서 `requestedConversionAt`이 있는 항목을 전환 요청 대기 건으로 표시합니다.
- 수신함 헤더에 "카카오워크 전환 요청 N건이 실행 대기 중입니다."를 표시합니다.
- 전환 요청 항목은 연한 파란 배경과 `전환 요청됨` 배지로 강조합니다.
- 버튼 문구는 요청/데이터 상태에 따라 `견적 초안 생성`, `전환 요청 실행`, `회의/견적 후보 등록`, `할 일 등록`, `전환 완료`로 바뀝니다.

검증:
- `npx tsc --noEmit` 성공
- `/erp-flow` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/erp-flow/page.tsx`

### Work Unit ↔ ERP Intake 병합 확정

날짜:
- 2026-05-24 KST

현재 조치:
- `POST /api/work-units/intake-candidates`가 병합 후보 확정을 처리합니다.
- 요청은 `workUnitId`, `intakeId`, `note`를 받습니다.
- work unit에 `erp_intake=...`, `erp_intake_status=...`, `erp_merge_score=...`, `erp_merge_reason=...` evidence를 저장합니다.
- 고득점 후보는 `validationStatus: "일치"`, 그 외는 `부분일치`로 표시합니다.
- `/work-units` 후보 카드에 `병합 근거 저장` 버튼을 추가했습니다.

검증:
- `npx tsc --noEmit` 성공
- 샘플 후보 확정 시 `validationStatus=일치`, `erp_intake=ERP-IN-KW-confirm-test-001`, `erp_merge_score=89` 저장 확인
- `/work-units` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/work-units/intake-candidates/route.ts`
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`
- `docs/nenova-work-unit-cross-validation.md`

### ERP Intake AI 보정 큐

날짜:
- 2026-05-24 KST

현재 조치:
- `GET/POST /api/erp/intake/ai-review`를 추가했습니다.
- GET은 고객, 금액, 추출된 마감일 근거가 부족한 수신함을 AI 보정 큐로 반환합니다.
- POST는 선택 항목을 `/api/assistant`로 보내 `mode=erp-intake-ai-review` 컨텍스트에서 Claude/GPT 검증을 요청합니다.
- API 키가 없으면 기존 assistant demo 응답으로 흐름 검증이 가능합니다.
- `/erp-flow`에 "AI 보정 큐" 섹션과 `AI 보정 요청` 버튼을 추가했습니다.

검증:
- `npx tsc --noEmit` 성공
- `GET /api/erp/intake/ai-review` 응답 확인
- 샘플 `ERP-IN-ai-review-test-001` POST가 `claude-demo` 응답을 반환하는 것 확인
- `/erp-flow` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/erp/intake/ai-review/route.ts`
- `nenova-erp-ui/src/app/(app)/erp-flow/page.tsx`
- `nenova-erp-ui/src/app/api/assistant/route.ts`

### Work Units 검증상태 필터

날짜:
- 2026-05-24 KST

현재 조치:
- `/work-units` 계정별 업무영역 필터에 `검증상태` 필터를 추가했습니다.
- `전체`, `일치`, `부분일치`, `충돌`, `검증대기` 기준으로 작업단위 목록을 볼 수 있습니다.
- 병합 확정 후 `일치`로 바뀐 work unit을 빠르게 확인하는 용도입니다.

검증:
- `npx tsc --noEmit` 성공
- `/work-units` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`

### 핵심 방향 재정렬: ERP보다 직원 워크플로우

날짜:
- 2026-05-24 KST

사용자 정정:
- 사용자가 중요하게 보는 것은 ERP 자체가 아니라 `nenova.exe` 작업데이터, 카톡/카카오워크 데이터, PC 작업데이터를 통해 직원 한 명 한 명의 업무를 파악하고 회사 전체 직원의 워크플로우를 확인하는 것입니다.
- ERP/수신함/견적은 보조 근거이지 첫 번째 중심 화면이 아닙니다.

현재 조치:
- `/work-units` 상단을 직원별 실제 업무 흐름 중심으로 재구성했습니다.
- 직원별 카드에 작업 수, 작업 시간, 대화 연결 수, PC 근거 수, 소스 비중, 최근 흐름, 업무 리스크를 표시합니다.
- 회사 전체 워크플로우 예측 섹션을 추가해 업무 카테고리 전환 흐름을 표시합니다.
- 시간대별 업무량 섹션을 추가해 분/시간 단위 업무량과 참여 직원 수를 표시합니다.
- 데이터 소스 커버리지 섹션을 추가해 `nenova.exe`, 카톡/워크, PC 데이터 수집 비중을 표시합니다.
- 확인 필요한 흐름 섹션을 추가해 대화 미연결, 검증대기, 충돌 항목을 먼저 보게 했습니다.
- ERP 수신함 병합 후보는 "보조 데이터 연결 후보"로 이름을 바꾸고 아래쪽으로 내렸습니다.
- 사이드바 메뉴명을 `직원 워크플로우`로 변경했습니다.

검증:
- `npx tsc --noEmit` 성공
- `/work-units` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`
- `nenova-erp-ui/src/lib/nav.ts`
- `docs/nenova-work-unit-cross-validation.md`

### KakaoTalk 원본 메시지 → Work Unit 연결

날짜:
- 2026-05-24 KST

현재 조치:
- `GET/POST /api/kakaotalk/messages`를 추가했습니다.
- 단건/배치 메시지와 KakaoTalk export `rawText`를 받아 `data/kakaotalk-messages.json`에 저장합니다.
- 메시지 텍스트에서 견적/계약/프로젝트/할일/정산/재고/고객응대 의도를 1차 추론합니다.
- `GET/POST /api/work-units/talk-candidates`를 추가했습니다.
- work unit과 카톡 메시지를 시간차, 카테고리, 대화방명, 미연결 여부로 점수화합니다.
- 후보 확정 시 work unit의 `relatedTalks`, `talkRelation`, `evidence`, `validationMemo`, `validationStatus`가 갱신됩니다.
- `/work-units`에 "카톡 연결 후보" 섹션과 `카톡 근거 저장` 버튼을 추가했습니다.

검증:
- `npx tsc --noEmit` 성공
- `/work-units` HTTP 200 확인
- 샘플 `KT-talk-test-001`과 `WU-talk-test-001`이 90점 `대화후작업` 후보로 잡히고, 확정 시 work unit evidence에 `kakaotalk=...`, `talk_merge_score=90`이 저장되는 것 확인
- 테스트 로컬 데이터는 정리 완료

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/kakaotalk/messages/route.ts`
- `nenova-erp-ui/src/app/api/work-units/talk-candidates/route.ts`
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`
- `docs/nenova-exe-work-unit-ingest.md`

### Talk/Work 메시지 → PC 작업 후보 확장

날짜:
- 2026-05-24 KST

현재 조치:
- `GET/POST /api/work-units/talk-candidates`가 이제 `data/kakaotalk-messages.json`과 `data/kakaowork-events.json`을 함께 읽습니다.
- 카카오워크 이벤트는 `resolveEmployeeIdentity`로 내부 `accountId`를 찾아 `TalkMessage`로 정규화합니다.
- 후보 점수에 `same_account`, `kakaowork_source`, `session_work_unit` 가중치를 추가했습니다.
- 카카오워크/카카오톡 자체가 만든 work unit은 후보 target에서 제외하고, PC/nenova.exe/`NX-SESSION-...` 작업 단위를 우선 매칭합니다.
- `/work-units` 문구를 "카톡 연결 후보"에서 "톡/워크 연결 후보"로 바꾸고, 후보 카드에 `KakaoTalk`/`KakaoWork` source가 보이게 했습니다.
- 직원별 업무 흐름 카드에서 미저장 PC 세션 후보가 있으면 리스크 배지에 `세션 후보 N`으로 표시합니다.

검증:
- `npx tsc --noEmit` 성공
- `GET /api/work-units/talk-candidates`가 `kakaoworkMessages`, `targetWorkUnits`를 반환하고 카카오워크 후보를 점수화하는 것 확인
- `/work-units` HTTP 200 확인
- 브라우저에서 "톡/워크 연결 후보"와 `KakaoWork 메시지` 후보 렌더링 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/work-units/talk-candidates/route.ts`
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`
- `docs/nenova-work-unit-cross-validation.md`

### Work Units 화면: 통계보다 명확한 데이터 원장

날짜:
- 2026-05-24 KST

사용자 정정:
- 사용자는 통계/예측/비중을 보고 싶은 것이 아니라 직원별 실제 작업 데이터가 명확하게 보이길 원합니다.
- 첫 화면에서 숫자 카드나 워크플로우 예측보다 작업ID, 직원, 시간, 앱/창, 대화 원문, PC 근거, 원본 이벤트 ID가 보여야 합니다.

현재 조치:
- `/work-units` 상단을 "직원 작업 데이터 원장"으로 변경했습니다.
- 통계 카드, 회사 전체 워크플로우 예측, 시간대별 업무량, 데이터 소스 커버리지, 계정별 요약, 관계별 요약 섹션은 화면에서 숨겼습니다.
- 첫 번째 주요 섹션을 "실제 작업 데이터" 테이블로 바꿨습니다.
- 테이블 컬럼: `작업ID/시간`, `직원/계정`, `작업 내용`, `PC 화면`, `대화 원문`, `원본 근거`, `검증`.
- `원본 근거`에는 `raw_event_id`, `session_id`, `event_ids`, talk id, hostname, process, active_window, clicks, keys, screen_summary가 직접 보입니다.
- 필터는 직원/업무영역/검증상태만 유지했습니다.

검증:
- `npx tsc --noEmit` 성공
- `/work-units` HTTP 200 확인
- 브라우저에서 `실제 작업 데이터`와 주요 컬럼 렌더링 확인
- 브라우저에서 이전 통계 문구 `총 작업 시간`, `회사 전체 워크플로우 예측`이 화면에 보이지 않는 것 확인
- 텍스트 overflow 검사에서 문제 없음

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`

### Workflow 별도 페이지

날짜:
- 2026-05-24 KST

사용자 요청:
- `nenovaweb.com/workflow` 페이지에 직원 작업 데이터 원장을 따로 볼 수 있게 만들어야 합니다.

현재 조치:
- `/workflow` 라우트를 추가했습니다.
- `/workflow`는 현재 실제 작업 데이터 원장 UI를 재사용합니다.
- 사이드바 `직원 워크플로우` 메뉴의 대표 주소를 `/work-units`에서 `/workflow`로 변경했습니다.
- 기존 `/work-units`도 직접 접근 가능하게 남겨두었습니다.

검증:
- `npx tsc --noEmit` 성공
- `GET /workflow` HTTP 200 확인
- 브라우저에서 `http://127.0.0.1:3000/workflow` 접근 시 `실제 작업 데이터`, `작업ID/시간`, `직원/계정`, `PC 화면`, `대화 원문`, `원본 근거`, `검증` 컬럼이 보이는 것 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/workflow/page.tsx`
- `nenova-erp-ui/src/lib/nav.ts`

### Nenova.exe 원본 이벤트 → Work Unit 브릿지

날짜:
- 2026-05-24 KST

현재 조치:
- `GET/POST /api/nenova-exe/events`를 추가했습니다.
- `nenova.exe` 원본 PC 이벤트를 `data/nenova-exe-events.json`에 저장합니다.
- 같은 요청에서 원본 이벤트를 직원 작업 단위 payload로 변환해 내부적으로 `/api/work-units`에 동기화합니다.
- 지원 필드: `id`, `type/eventType`, `sessionId`, `parentEventId`, `timestamp`, `userId`, `userEmail`, `employeeName`, `accountId`, `hostname`, `deviceId`, `data.app/app`, `processName/exe`, `executablePath`, `windowTitle/activeWindowTitle/activeWindow`, `mouseClicks/clickCount/recentClicks/mouseRegions/mousePositions`, `keyboardCount/keyCount/keystrokes/textLength`, `screenSummary/visionSummary/screenText/ocrText`, `startedAt/endedAt/period`, `durationSec/activeSeconds`.
- 앱/프로세스/실행 경로에 `nenova.exe`가 있으면 source를 `nenova.exe`, 아니면 `PC`로 저장합니다.
- hostname/email/accountId/KakaoWork userId로 직원 계정을 매칭합니다.
- evidence에 `session_id`, `hostname`, `event_type`, `process`, `executable`, `active_window`, `mouse_clicks`, `keyboard_count`, `screen_summary`를 남깁니다.
- 생성된 work unit은 기본 `validationStatus: "검증대기"`이며 이후 카톡/워크/ERP/구글시트 근거와 연결해 검증합니다.

검증:
- `npx tsc --noEmit` 성공
- `GET /api/nenova-exe/events` HTTP 200 확인
- 샘플 `nx-test-001` POST 시 `workUnitSync.ok=true`, 직원 `설연주`, 카테고리 `견적`, workUnitId `NX-nx-test-001` 생성 확인
- 테스트 로컬 데이터는 정리 완료
- `/work-units` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/nenova-exe/events/route.ts`
- `docs/nenova-exe-work-unit-ingest.md`

### Nenova.exe 원본 이벤트 세션 병합

날짜:
- 2026-05-24 KST

현재 조치:
- `GET/POST /api/nenova-exe/sessions`를 추가했습니다.
- `data/nenova-exe-events.json`의 원본 이벤트를 직원 실제 업무 세션 단위로 병합합니다.
- 그룹 기준은 `accountId`, `sessionId`, `category`, `appName`이고, 기본 `gapMin=5`분을 넘으면 다른 세션으로 나눕니다.
- 세션 source는 포함 이벤트 중 하나라도 `nenova.exe`이면 `nenova.exe`, 아니면 `PC`입니다.
- 세션 작업 단위 id는 `NX-SESSION-...` 형식입니다.
- 세션 work unit에는 원본 event ids, 세션 시간, 클릭 합계, 키보드 합계, 화면요약 개수, 주요 창 제목을 evidence/pcEvidence로 저장합니다.
- `/work-units`에 "PC 세션 병합 후보" 섹션을 추가했습니다.
- 후보 카드에서 `세션 작업단위 저장`을 누르면 `/api/nenova-exe/sessions` POST로 해당 세션이 `/api/work-units`에 저장됩니다.

검증:
- `npx tsc --noEmit` 성공
- 샘플 `nx-session-test-001/002` 이벤트 2건이 기본 `gapMin=5`에서 세션 1건으로 병합되는 것 확인
- 병합 세션 POST 시 `workUnitSync.ok=true`, `source_events=2`, `NX-SESSION-...` 작업 단위 생성 확인
- `gapMin` 미입력 시 URL `null`이 0으로 읽혀 1분으로 줄어드는 문제를 고쳤습니다.
- 테스트 로컬 데이터는 정리 완료
- `GET /api/nenova-exe/sessions` HTTP 200 확인
- `/work-units` HTTP 200 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/api/nenova-exe/sessions/route.ts`
- `nenova-erp-ui/src/app/(app)/work-units/page.tsx`
- `docs/nenova-exe-work-unit-ingest.md`

### Watcher 데이터 품질 공통 필터

날짜:
- 2026-05-24 KST

사용자 요청:
- 금요일 마지막 작업인 `app명 오염/클립보드 노이즈/Vision 미작동` 수정을 이어서 더 단단하게 보강해야 합니다.
- `nenova.exe` 작업데이터, 카톡/카카오워크 대화데이터, PC 작업데이터가 3차 교차검증될 때 앱명/창제목 오염 때문에 같은 오류가 반복되면 안 됩니다.

현재 조치:
- `src/data-quality.js` 공통 필터를 추가했습니다.
- 앱명 정규화에서 `.exe` 별칭을 처리합니다. 예: `nenova.exe -> nenova`, `chrome.exe -> chrome`, `msedge.exe -> edge`.
- 앱명 오염값을 차단합니다. 예: JSON 이벤트, PowerShell 명령어, 버전번호, 프로세스 목록.
- 창제목 정제에서 프로세스 목록/PowerShell 명령어를 차단하고 이메일, URL 파라미터, 사용자 홈 경로를 마스킹합니다.
- 클립보드 노이즈 필터를 공통화했습니다. 단순 앱명/프로세스 목록/윈도우 타이틀 오염은 버리고, 발주/견적/테이블 텍스트는 유지합니다.
- `keyboard-watcher.js`, `clipboard-watcher.js`, `screen-capture.js`가 같은 공통 필터를 사용하게 변경했습니다.
- 스크린캡처 프로파일 키가 `.exe` 앱명 때문에 `unknown`으로 빠지지 않게 했습니다.

검증:
- `npx jest tests\data-quality.test.js --runInBand` 성공
- `node -e "require('./src/data-quality'); require('./src/keyboard-watcher'); require('./src/clipboard-watcher'); require('./src/screen-capture'); console.log('modules ok'); process.exit(0)"` 성공
- `npx jest --runInBand` 성공, 8개 테스트 스위트 / 144개 테스트 통과

다시 반복되면 먼저 볼 위치:
- `src/data-quality.js`
- `src/keyboard-watcher.js`
- `src/clipboard-watcher.js`
- `src/screen-capture.js`
- `tests/data-quality.test.js`

### 입고단가·송금 변경내역 패널

날짜:
- 2026-05-24 KST

사용자 요청:
- 입고단가 송금 메뉴 페이지에서 변경내역이 있는 품목을 옆에 별도 리스트로 볼 수 있어야 합니다.

현재 조치:
- `/inventory` 메뉴명을 `입고단가·송금`으로 변경했습니다.
- 품목 데이터에 `transferStatus`, `transferMemo`, `updatedAt` 필드를 추가했습니다.
- `ProductChangeRecord` 변경 이력 모델을 추가했습니다.
- 입고/출고, 단가 변경, 송금상태 변경, 품목등록 시 변경내역이 자동 기록됩니다.
- `/inventory` 오른쪽에 `변경내역 있는 품목` 패널을 추가했습니다.
- 변경내역이 있는 품목만 별도 리스트로 보이고, 최근 3건의 변경 타입/전후값/메모/작업자를 확인할 수 있습니다.
- 기존 브라우저 저장소의 오래된 품목 데이터도 seed 기준 송금상태를 보정해서 보이게 했습니다.

검증:
- `npx tsc --noEmit` 성공
- 브라우저 `http://127.0.0.1:3000/inventory`에서 `입고단가·송금`, `변경내역 있는 품목`, `송금완료`, `송금대기`, `단가변경` 렌더링 확인

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/app/(app)/inventory/page.tsx`
- `nenova-erp-ui/src/lib/store.ts`
- `nenova-erp-ui/src/lib/nav.ts`

### 차수피벗 차수 입력 잘림

날짜:
- 2026-05-24 KST

사용자 요청:
- `nenovaweb.com/shipment/week-pivot?weekFrom=2026-21-01&weekTo=2026-21-01` 차수피벗 페이지에서 차수 입력값이 `2026-20-0`처럼 잘려 보이는 문제 수정.

중요 원인:
- 이 화면의 실제 소스는 `mindmap-viewer/nenova-erp-ui`가 아니라 `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업` 저장소에 있습니다.
- 공통 `WeekInput` 입력칸 폭이 `60px` 고정이라 `YYYY-WW-SS` 형식을 담기 부족했습니다.

현재 조치:
- `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\lib\useWeekInput.js`
  - `YYYY-WW-SS` 형식 포맷/입력/이전·다음 이동 지원.
  - `WeekInput` 폭을 `112px`로 확대하고 shrink 방지.
- `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\pages\shipment\stock-status.js`
  - URL `weekFrom/weekTo` 쿼리값 초기 반영.
  - 차수 컨트롤 영역이 줄어들지 않도록 `minWidth: max-content`, `overflow: visible`.
- `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\pages\shipment\week-pivot.js`
  - `/shipment/week-pivot` 라우트 추가, 기본 차수피벗 탭 연결.

검증:
- `npm run build` 성공.
- `http://127.0.0.1:3001/shipment/week-pivot?weekFrom=2026-21-01&weekTo=2026-21-01` 확인.
- 브라우저 측정: 두 입력칸 모두 value `2026-21-01`, `clientWidth=110`, `scrollWidth=110`으로 잘림 없음.

다시 반복되면 먼저 볼 위치:
- `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\lib\useWeekInput.js`
- `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\pages\shipment\stock-status.js`
- `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\pages\shipment\week-pivot.js`

### 차수피벗 엑셀 자연어 품목명

날짜:
- 2026-05-24 KST

사용자 요청:
- 차수피벗에서 엑셀 다운로드 시 품목이름 옆 셀에 자연어 품목명도 표시.

현재 조치:
- 실제 소스 위치: `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\pages\shipment\stock-status.js`
- `naturalProdName(p)` helper 추가.
- 엑셀 헤더를 `국가 / 꽃 / 품명 / 자연어 / 차수별 업체...` 순서로 변경.
- 자연어 컬럼 값은 `국가 꽃 품명` 형태입니다. 예: `콜롬비아 수국 Blue (블루)`.

검증:
- `npm run build` 성공.

다시 반복되면 먼저 볼 위치:
- `C:\Users\pc\OneDrive\Pictures\Desktop\커서 작업\pages\shipment\stock-status.js`

### 네노바웹 메뉴 중복/겹침 정리

날짜:
- 2026-05-24 KST

사용자 요청:
- 네노바웹 메뉴에서 겹치는 것을 정리.

현재 조치:
- `nenova-erp-ui/src/lib/nav.ts`
  - 기존 단일 메뉴 배열을 `NAV_GROUPS`로 재구성.
  - 메뉴 그룹: `홈`, `실무 처리`, `검증·자동화`.
  - 긴/겹치는 라벨 축약:
    - `ERP 흐름` → `업무 흐름`
    - `신규 주문` → `주문`
    - `입고단가·송금` → `입고/송금`
    - `고객 관리` → `고객`
    - `직원 워크플로우` → `작업 원장`
    - `워크 연동` → `카카오워크`
- `nenova-erp-ui/src/components/Sidebar.tsx`
  - 사이드바를 그룹 단위로 렌더링.
  - 아이콘 영역 폭 고정, 라벨 `truncate`, 메뉴 스크롤 적용으로 겹침 방지.

검증:
- `npx tsc --noEmit` 성공.
- 브라우저 `http://127.0.0.1:3000/inventory`에서 사이드바 그룹/메뉴 렌더링 확인.

다시 반복되면 먼저 볼 위치:
- `nenova-erp-ui/src/lib/nav.ts`
- `nenova-erp-ui/src/components/Sidebar.tsx`

### CLAUDE.md 10만 스타 가드레일 적용

날짜:
- 2026-05-25 KST

사용자 요청:
- GitHub에서 10만 개 이상 스타를 받은 `CLAUDE.md` 파일 내용을 우리 프로젝트에도 적용.

확인한 외부 기준:
- `forrestchang/andrej-karpathy-skills` 및 `multica-ai/andrej-karpathy-skills`의 `CLAUDE.md`.
- 핵심 원칙: 구현 전 사고, 단순성 우선, 수술식 변경, 검증 가능한 목표.

현재 조치:
- 루트 `CLAUDE.md` 상단 `절대 규칙` 아래에 `000. Karpathy식 에이전트 코딩 가드레일` 추가.
- 원문 전체 복사가 아니라 Nenova/Orbit 위험 영역에 맞춰 적용:
  - 직원 PC/데몬/배포/데이터 삭제·수정/자동 실행은 더 엄격히 가정과 범위 확인.
  - 기존 패턴 우선.
  - 요청과 직접 연결된 파일만 수정.
  - 검증 불가 영역은 완료처럼 말하지 않기.

검증:
- `Get-Content -Path CLAUDE.md -TotalCount 90`로 상단 삽입 확인.

다시 반복되면 먼저 볼 위치:
- `CLAUDE.md`의 `000. Karpathy식 에이전트 코딩 가드레일`.

### Nenova Computer Use Lab 고성능 OCR/로컬 조작 확장

날짜:
- 2026-05-25 KST

사용자 요청:
- Windows 내장 OCR 성능이 낮으므로 Claude Vision 수준에 가까운 OCR을 추가하고, Nenova 업무 분석에 맞춘 OCR 성능을 디벨롭.
- 기존 모든 툴의 성능을 계속 디벨롭하는 개념으로, macOS Claude Computer Use처럼 조작 기능도 발전.

현재 조치:
- `scripts/nenova-cu.js`
  - `ocr --engine best|vision|local` 추가/확장.
  - `best` 모드는 Claude Vision CLI → Tesseract → Windows OCR 순서로 시도.
  - Claude Vision OCR 프롬프트는 Nenova 업무 화면 전용 JSON(`text`, `lines`, `fields`, `guiElements`, `businessIntent`)을 요구.
  - Windows OCR/Tesseract 결과에도 Nenova 업무 후처리 적용.
  - OCR 보정 사전 추가: `거래서→거래처`, `고객멍→고객명`, `오르빗→Orbit` 등.
  - 업무 필드 추출: `거래처`, `주문번호`, `품목`, `수량`, `날짜`, `금액`, 화면유형, 앱유형.
  - `desktop-run` 추가: 로컬 PC 클릭/입력/단축키/대기 액션 지원.
  - 기본은 dry-run, `--execute`가 있을 때만 실제 로컬 조작.
  - 실제 실행 시 전/후 스크린샷과 후처리 OCR 결과를 artifact로 저장.
- `docs/nenova-computer-use-lab.md`
  - OCR 엔진 우선순위, Nenova 보정, desktop-run 사용법, 안전 경계 문서화.

검증:
- `node --check scripts\nenova-cu.js` 성공.
- `node scripts\nenova-cu.js ocr --image artifacts\nenova-cu\ocr-smoke-ko.png --engine best`
  - Claude Vision 시도 후 Windows OCR fallback.
  - 결과: `네노바 주문 테스트 12345 거래처: Orbit 플라워`
  - fields: `customer=Orbit 플라워`, `screen=order`, `app=nenova`
  - corrections: `거래서→거래처`, `오르빗→Orbit`
- `node scripts\nenova-cu.js desktop-run --click "100,200" --type "네노바 테스트"`
  - dry-run 성공, 실제 조작 없음.
- `node scripts\nenova-cu.js health`
  - Python, pyautogui, Pillow, Playwright, Windows OCR 사용 가능.
  - Tesseract 미설치.
  - Claude CLI 경로 감지됨. 단, Claude Vision 실제 사용은 CLI 로그인 상태 필요.

다시 반복되면 먼저 볼 위치:
- `scripts/nenova-cu.js`
- `docs/nenova-computer-use-lab.md`
- `artifacts/nenova-cu/*.json`

### Nenova Computer Use Lab 영상형 프리뷰

날짜:
- 2026-05-25 KST

사용자 요청:
- `nenova-cu`가 어떻게 작업하는지 프리뷰 화면에서 영상처럼 보여지게 하기.
- 어느 구간을 클릭했는지, 어느 구간을 OCR 처리/분석했는지까지 표시.

현재 조치:
- `scripts/nenova-cu.js`
  - `preview --latest 80` 명령 추가.
  - 최근 `artifacts/nenova-cu/*.json`을 읽어 `preview.html` 생성.
  - OCR 결과의 word bounding box를 초록 박스로 표시.
  - `desktop-run` 클릭 위치를 십자 마커로 표시.
  - 입력/단축키 액션은 화면 위 액션 박스로 표시.
  - Playwright `web-audit` 요소는 웹 요소 박스로 표시.
  - Play/Pause/Prev/Next 타임라인 UI 생성.
- `docs/nenova-computer-use-lab.md`
  - `preview` 명령과 시각화 범위 문서화.

검증:
- `node --check scripts\nenova-cu.js` 성공.
- `node scripts\nenova-cu.js preview --latest 80` 성공.
- 생성 파일: `artifacts/nenova-cu/preview.html`
- frameCount: 9
- HTML 안에 OCR word boxes, desktop click marker, web element overlay 데이터 확인.

다시 반복되면 먼저 볼 위치:
- `scripts/nenova-cu.js`의 `preview`, `collectPreviewFrames`, `buildPreviewHtml`
- `artifacts/nenova-cu/preview.html`

## 2026-06-12~13 — Vision 파이프라인 부활 + DATA_CHECK.md 확립
- 요청: 데이터 확인 방식을 MD에 고정 저장 / 분석 0% 원인 규명
- 검색어: capture-funnel, vision/stat, claim-token, sendImage, _heapPressure
- 원인(확정): ① 서버 ANTHROPIC_API_KEY 무효(401) → 교체+검증 완료 ② owner PC 임시ID 설치→self-healer 토큰 자기파괴 루프(치유#69) → claim-token으로 MNH03H73690BB2CD82 복구 ③ mouse_click 이미지 게이트 죽은코드 → f838f92 수정 ④ 설연주/강현우 데몬 크래시루프(uiohook 실패/updater dead-loop) — 미해결
- 수정 파일: src/screen-capture.js(2082b5f, f838f92), DATA_CHECK.md(86ec7ab), ~/.orbit-config.json(토큰)
- 검증: /api/vision/stat processed 0→1 (첫 실화면 분석 성공, 2026-06-13 00시)
- 미해결: processed 증가했는데 screen.analyzed 이벤트 미저장(저장 경로 버그) — DATA_CHECK.md '추적 중' 참조
- 재발 시 먼저 볼 곳: **DATA_CHECK.md** (표준 runbook, 함정 9종)

## 2026-06-15 — 설치코드 근본수정 (원인→픽스)
- 요청: 지금까지 파악한 원인 반영한 '문제없는 설치코드 최종본' 검증 후 작성
- 설치경로 정리: 직원=install-open.bat→install-open.ps1(auto-register 이름매칭→실토큰)→install.ps1. owner가 쓴 clean-install.ps1은 임시ID 경로(문제 근원 중 하나)
- 근본원인→픽스:
  1) self-healer 토큰 자기파괴(_clearTokenCache가 디스크 토큰 삭제) → personal-agent.js 무력화 (4e8aa0a)
  2) OrbitCodeSync가 git pull만 하고 데몬 재시작 안 함→구코드 며칠 실행(강현우 72h) → install.ps1 line432 HEAD변경시 재시작 (a3a5e88)
  3) OrbitWatchdog 30분 폴링 vs 원격명령 5분 TTL 불일치 → 원격 restart/update 자주 빗나감 (미수정, 명령TTL 연장 or 폴링단축 필요)
  4) auto-register는 issueApiTokenAsync(PG await)로 claimable 토큰 발급 → 정상
- 검증: PowerShell AST 파서로 install.ps1 전체 + 생성 orbit-code-sync.ps1 본문 문법 통과
- 미완(라이브 e2e는 서버 502 안정화 + 테스트PC 필요): install-open.ps1 설치후 자가검증(토큰verify+이벤트도착) 추가, 임시ID hard-fail
- 재발 시 먼저: DATA_CHECK.md + 이 항목

## 2026-06-15 (속행) — 남은 3개 완료
- #1 라이브 e2e: auto-register(name=jaeyong lim)→matchedByName=true·실유저 MNH03H·토큰len54→auth/verify 즉시 ok. install/verify verified=true chunks20. (E2E-TEST-PC/VERIFY-TEST-PC pc_link 테스트잔여 — 가짜hostname이라 무해)
- #2 명령 TTL 5→40분 (server.js ~1904) — watchdog 30분폴링이 force-restart/update를 반드시 1회 잡음. node -c 통과 (b로 시작 커밋)
- #3 install-open.ps1 설치 자가검증 추가 — 토큰 verify + install/verify 폴링(2분)→PASS/FAIL. AST 통과 + 자가검증 로직 라이브(tokenOk/dataOk=True)
- 커밋: a3a5e88(codesync restart), 4e8aa0a(token), +TTL/verify 커밋. 전부 push→배포
- 재발 시: DATA_CHECK.md + 이 기록

## 2026-06-17 — 서버 OOM 위기 + Vision 무과금 + 신규3명 + 디테일 저하 (대규모)
### 요청 흐름
- Vision API 비용 → owner PC CLI 무과금 전환; 신규 PC 데이터 확인; 서버 502 반복 원인; 키보드/카톡 디테일 저하 확인
### 핵심 사고: 서버 OOM (오늘 종일 502의 진짜 범인)
- railway logs: FATAL heap limit(742→787MB) 78초마다 크래시루프
- 사슬: Drive 403 무한재시도 → daemon.log 8.7MB → 거대 이벤트/snapshot 폭주 → 서버 OOM. + 크래시루프 데몬 daemon.update 폭주 + 서버가 이벤트를 Haiku로 [AI분석] → 부하/비용. + 내 force-restart/update 수십번 = 명령큐 누적
- 해결(영구): railway 변수 GOOGLE_DRIVE_CAPTURES_FOLDER_ID 제거 → drive-config 무조건 enabled:false (백업값 1XvD0BwymPoQLthnLezgqftVm0D-27Uh5). + /api/admin/drive-toggle {enabled:false}(global._driveDisabled). 단 실행중 데몬은 재시작해야 반영
### 수정 커밋
- 4e8aa0a self-healer 토큰 자기파괴 제거 / a3a5e88 OrbitCodeSync 코드변경시 데몬재시작 / f838f92 mouse_click 이미지 / ceda93f 명령TTL40분+install-open 자가검증 / 40c589f vision 워커 OFF토글(VISION_SERVER_WORKER=off, Railway변수도 설정) / drive-toggle 커밋
### 무과금 Vision
- owner PC: bin/vision-worker.js --server-queue --night (CLI Max구독, ANTHROPIC_API_KEY 비움) HKCU\Run+시작프로그램 자동기동. 서버 유료워커는 VISION_SERVER_WORKER=off(런타임토글+Railway변수)
### 신규 3명 (오늘 설치)
- 강명훈=DESKTOP-L0C2IOT(MNMSAQJD78E5, 이름정상) / 김빛나=NENOVA2025(MN0B1204A46C4B8EAC, update-user-name으로 등록완료) / 정재훈=nenova(MND11FFB8C, PC꺼짐 미등록 — 켜지면 등록)
- 이름등록 엔드포인트: POST /api/admin/update-user-name {userId,name} (admin토큰=dlaww584 config토큰, 데이터 유지)
### 디테일 저하 (중요)
- 직원들 keyboard.chunk=0 (설연주/김빛나/강현우) → 타이핑/카톡 디테일 사라짐. owner만 풀(keyboard28+screen105+clipboard). 원인=uiohook 키보드후킹 실패 + 크래시루프가 실작업캡처 밀어냄. 데몬 안정화 후 복구 기대, 안되면 uiohook 코드진단
### 도구/교훈
- railway CLI 로그인됨(dlaww584, tranquil-analysis/mindmap-viewer). railway logs/redeploy/variables 사용가능
- 잦은 push=재배포 churn으로 502 악화 → 모아서 push. 데이터문제는 DATA_CHECK.md 먼저, 재부팅 금지
### 재발 시 먼저 볼 곳: DATA_CHECK.md + memory(server-oom-drive-flood, no-reboot-use-selfheal, vision-cli-worker-local)

---
## 2026-06-17 (오후) — 서버 OOM(daemon.update 폭주) + 원격 재시작 레버 정립

**사용자 요청 핵심**: ①"데이터 확인" 시 처리절차를 MD에 ②연결 PC 전부 재점검 ③김빛나 PC 왜 그런지(바이러스?) ④이 상황 재발방지 MD화.

**검색/확인**: src/daemon-updater.js(GUARDIAN_ONLY_ACTIONS, executeCommand, pullAndRestart), setup/guardian-watchdog.ps1, server.js /api/hook(insertEvent, _heapPressure), railway logs.

**진단 결과**:
- 서버 OOM 2차 원인 = crash-loop 데몬의 daemon.update 폭주 → PG 연결 타임아웃 → insertEvent 적체 → heap 760MB OOM. (오늘 전직원 데이터 안 들어온 진짜 주범)
- 원격 재시작이 안 닿던 이유 = restart/update가 GUARDIAN_ONLY_ACTIONS 위임 블랙홀(워커가 같은 큐 먼저 소비). gitpull-worker는 "최신"이면 skip, reclone-worker는 Windows 디렉터리 rename EBUSY 실패.
- 김빛나(NENOVA2025): 데몬·마우스·워커 살아있음(바이러스 통째 차단 아님). 화면캡처 모듈 반복死+keyboard 0. AV차단 vs 로드실패는 로그 증거없어 미확정→아침 daemon-self.log 필요. 원격레버 다 소진→전원주기로만 회생.

**수정 파일/커밋**:
- 5ec0814 src/daemon-updater.js — GUARDIAN_ONLY_ACTIONS=['reinstall'](restart/update 직접처리)
- 05ff191 server.js — /api/hook 힙압력 시 노이즈 저장 스킵
- 0b700f2·460b58d DATA_CHECK.md — "데이터 확인" 트리거절차+§13 레버+§13-Z 좀비+§10 OOM②

**검증**: 정재훈(nenova) gitpull-worker로 재시작 성공(87m→1m). 서버 재배포 후 5/5 200 안정. 김빛나는 4종 레버 다 무반응(전원주기 대기).

**반복 시 먼저 볼 위치**: DATA_CHECK.md ★"데이터 확인" 트리거 / §10(서버 OOM 메타규칙) / §13(원격레버)·§13-Z(좀비). 메모리 no-reboot-use-selfheal.

---
## 2026-06-25 KST — 데몬 자가해결 체계 + 화면캡처 검은화면 근본수정 + nowlink 다운로드

**프로세스 반성(사용자 지적)**: 이 세션에서 데몬/설치 수정을 연속하며 **작업 전 WORK_MEMORY/DAEMON_STRUCTURE 재확인을 건너뛰었음**. 그 결과 신원 혼동(아래) 발생. 다음부터 데몬/설치 작업은 무조건 prework-search + 이 파일 먼저.

**★신원(2026-06-25 실데이터로 확정 — 6/17 잠정메모 정정)**:
- **김빛나 = hostname NENOVA(=소문자 nenova 동일머신) = userId MND11FFB8CBF0916DB**. 근거: 오늘 사용자가 직접 install-open으로 "김빛나" 등록 + pc-list에서 이 userId가 16:55까지 현역(3617 이벤트). 6/17 메모의 "정재훈=MND11FFB8C(PC꺼짐 미등록 잠정)"은 **미확정 추정이었고 오늘 등록으로 무효화됨.** 내가 이 잠정메모를 확정인 양 사용자에게 들이민 게 실수(2회 성급).
- NENOVA2025 = userId MN0B1204A4 = 별개 머신, 12:38 이후 비활성. 정체 미확정(6/17엔 김빛나로 잠정표기됐으나 오늘 활동은 NENOVA쪽). **단정 금지.**
- 교훈: 신원은 6/17 잠정메모가 아니라 **pc-list 최신활동 + 사용자 실시간 등록**을 1순위로. hostname 대소문자(NENOVA/nenova/NEONVA/NENOVA2025) 난립 = §9 함정.
- 이름표시 이슈: update-user-name은 orbit_auth_users 대상(대시보드용)인데 PG upsert pgOk:false로 실패(원인 미규명, SQLite만 됨). learning/logs의 userName은 이벤트 denormalized라 이걸로 안 바뀜 → 데몬이 config의 이름을 보내야 근본 반영. 보드에 MND11FFB8C로 뜨는 중.

**화면캡처 검은화면 근본원인(확정)**: `[3/9] Python` 단계의 `Get-Command python`이 **Windows 스토어 껍데기(WindowsApps\python.exe 0-byte 별칭)도 TRUE로 판정** → 실제 python 미설치인데 설치 건너뜀 → PIL/pyautogui 실패 → 데몬이 PS CopyFromScreen 폴백으로 **3KB 검은화면만** 생성. self-test로 PC별 확정: 설연주(neonva)·현욱(CAA5TA1)·임재용(S4S2HMU)=실제캡처 정상(250KB~1.3MB), 정재훈(nenova)=python없음 3KB 검은화면.

**수정 커밋(mindmap-viewer, 전부 push·배포)**:
- 9cb56a0 uiohook을 child process(uiohook-child.js)로 격리 — 은행 키보드보안 충돌 시 데몬 사망 방지. keyboard-watcher/mouse-watcher 둘 다 child 이벤트 구독(subscribeInput)
- b00d1f7·2d7766e self-healer가 bank-safe(isPaused) 중 컴포넌트 강제재시작 안 하게(uiohook crash 방지)
- 23ce9f7 install-open.bat UAC 승격 런처에 -NoProfile 추가(‘running scripts is disabled’ profile.ps1 빨간에러 제거)
- abe6fea install.ps1 실행정책 자가해제(Process/LocalMachine/CurrentUser) + trap에서 install.error 자동보고(복붙 불필요)
- 8624831·d4bd17f screen-capture 시작 시 캡처 자가테스트 → **daemon.screendiag** 이벤트로 직접 보고(guardian 명령채널 우회). detail에 method별 결과
- 2c442ca **GET /api/admin/raw-events?type=&hostname=** — learning/logs가 커스텀필드 깎는 문제 우회, 원본 data_json 조회(진단 필수 도구)
- bc0a887 install.ps1 [3/9] Python: Test-RealPython(실제 'Python 3.x' 검증)으로 스토어껍데기 배제 + winget→python.org 이중설치(PrependPath)
- 1e79861 screen-capture **python 자가탐색(_resolvePython, PATH밖도 설치폴더 검색)+자가설치(_autoInstallPython, user-scope 무권한 백그라운드)** — **재설치 없이** git pull만으로 검은화면 자가복구

**자가해결 체계 완성(사용자 핵심요구=babysitting 제거)**: 직원 재실행 없이 ①실행정책 자가해제 ②설치오류 자동보고 ③화면캡처 self-test 자동진단 ④python 없으면 데몬 자가설치. 새 오류만 1회 내가 고치면 그담부터 자동.

**nowlink.kr = ai-trainer-hub(별도 Next.js repo: Jayinsightfactory/ai-trainer-hub, master, Railway)**. mindmap-viewer 아님. /install은 자영업자 AI 출장설치 신청폼(상용). 커밋 4c8c5bc: /install에 직원용 Orbit 다운로드 카드 + **/orbit-install** 라우트(mindmap-viewer install-open.bat으로 302). 공유주소 nowlink.kr/orbit-install.

**워크플로우 융합 보드**: `C:\Users\USER\Documents\orbit-workflow-board\index.html` — 5913 관찰이벤트→1598 융합동작(화면캡처/화면해독/키보드/마우스/클립보드/주문/카카오톡/ERP), 자동화후보 412, 교차검증 78. 융합스크립트 /tmp(AppData\Local\Temp)\orbitfuse\fuse3.py·gen2.py. screen.analyzed(vision)는 06/17배치라 최근 키보드와 시각 어긋남.

**미해결/리스크**:
- 정재훈/김빛나 등 python 누락 PC: 자가설치 코드가 다음 git pull 후 작동하는지 daemon.screendiag로 확인 필요(설치 수분 소요)
- guardian가 exec/capture-diag 결과를 빈값으로 보고하는 명령채널 한계 → daemon.screendiag/raw-events로 우회 확립
- Register-ScheduledTask XML 포맷에러(schtasks.exe 폴백으로 자동시작은 정상) — 추후 정리
- 이름/계정 정정(김빛나↔정재훈 hostname 혼동) 확인 필요

**재발 시 먼저**: 이 항목 + DATA_CHECK.md(§13-Z 좀비, §9 hostname충돌) + DAEMON_STRUCTURE.md. 화면캡처 검은화면=python누락 의심→daemon.screendiag 확인. **신원은 989번줄(6/17 잠정) 말고 pc-list 최신활동+사용자 등록 우선**(위 ★신원 참조).

**검증 로그(2026-06-25)**: 김빛나 NENOVA daemon.screendiag 16:34/16:35/16:43에 "python 없음 감지 → 백그라운드 자동설치 시작" 트리거 확인(1e79861 작동). 단 16:43:49까지 still working=powershell(3KB 검은화면)=python 설치 완료 전. 데몬 잦은 재시작으로 _autoInstallPython이 매 재시작 재트리거(detached라 install은 살아남음). 추적: 설치 완료 후 working=pil 되는지. 안 되면 winget 부재/python.org 다운로드 실패 의심 → 동시중복설치 방지 lock-file 가드 검토.

**최종 상태(2026-06-25 야간)**:
- ✅ 완료·검증: 신원정정(WORK_MEMORY), 이름 "김빛나" PG반영(update-user-name UPDATE우선+ON CONFLICT제거, 9004f62, pgOk=True 확인·learning/logs userName=김빛나), 설치기/데몬 하드닝 전부 배포(-NoProfile 23ce9f7, 실행정책자가해제+install.error abe6fea, uiohook격리 9cb56a0, self-test+daemon.screendiag 8624831/d4bd17f, raw-events 2c442ca, python스토어껍데기 bc0a887, python자가탐색·자가설치 1e79861, 중복방지lock 2658d20, 설치결과보고형 4bcf2bf)
- ❌ **미검증(정직)**: 김빛나(NENOVA) 화면캡처 python 설치 **완료 못 확인**. self-heal은 트리거 증명됨(screendiag "python없음→자동설치 시작"). 그러나 (a)데몬이 야간 idle이라 capture트리거 거의 없고 (b)내 restart/update 명령에 데몬이 재시작 안 함(§13-Z 명령채널 안 닿음) → 설치가 거의 시도 안 돼 미완. 최신 self-test 17:12:48 이후 갱신 없음.
- **자동복구 경로**: 김빛나가 아침 **재부팅 시(=§13-Z 정석 회생)** 또는 활동 시작 시 self-test/capture가 _autoInstallPython 트리거 → 4bcf2bf 결과보고형이라 **"pyinstall OK" 또는 실패원인을 daemon.screendiag(status=py-install)로 자동 POST**. 그때 raw-events?type=daemon.screendiag&hostname=NENOVA로 확인. 즉시확정은 재설치 1회(설치기 python 이미 수정됨)뿐인데 사용자가 거부함.
- 교훈: 원격으로 idle PC의 백그라운드 설치 완료를 그 자리에서 강제·검증하는 건 명령채널 한계로 불가. 자가복구+자가보고를 심어두고 다음 전원주기/활동에 맡기는 게 현실적.

## 2026-06-25 (속행) — 온톨로지화 (audit P0/P2/P3/P4 실행)
- 요청: "작금의 작업들은 온톨로지화 되었는가" → 확인결과 골격(company-ontology/event-bus/golden/work-units)은 가동중이나 원시관찰이 자동 승격 안 됨. "모두작업" 지시로 구현.
- 기존 접지: unified_events(0010, source∈orbit/erp-ui/ai-trainer/nenova-agent), orbit_entity_golden(0011, person/customer/document/task, conf 1/2/3소스=0.34/0.67/1.0), event-bus.publish(ON CONFLICT 없음→멱등 위해 라우트서 직접 upsert). 관계 store는 없었음(audit P3).
- 만든 것(커밋 e0c1a47, push·배포):
  - `docs/nenova-ontology-spec.md`: 표준 객체(Action/Person/Customer/Document/Task/App/Room/Process)·관계 9종·provenance·confidence 명세(P0)
  - `migrations/0012_ops_relation.sql` + `routes/ops-ontology.js` ensureOpsTables: **ops_relation** 1급 관계 store(P3)
  - promote(): events(키보드/화면해독/마우스/클립/주문) → 사용자별 120s 시간창 융합 → Action(unified_events type=work.action, id=act:{uid}:{startSec}, 멱등) + ops_relation 멱등 upsert(P2). 관계: person_performed_action/action_in_app/action_in_room/screen_observed_action/automation_candidate_for_process. conf=소스종류수.
  - ops API(P4): POST /api/ops-ontology/promote?hours=N, GET /stats /entities?type= /relations?fromRef=&relType= /actions/:id/context(OAG패킷)
  - server.js 배선(require+app.use+init ensureOpsTables)
- 검증(라이브): promote?hours=720 → 315,178 원천 → **28,929 Action + 64,983 관계**. stats: 27,743 action(verified 7,858, automatable 277). 관계 action_in_app 28,670·person_performed 27,743·action_in_room 5,579·screen_observed 983·automation 550. OAG패킷(actions/:id/context) 정상(app·활동·증거2·관계4 반환). entities?type=person 12명(설연주 conf0.667 등).
- 미구현(spec엔 있으나 populate 안 됨, 다음): talk_triggered_action(시간창 대화→작업), action_mentions_customer/action_updated_erp(OCR/ERP 추출 연결=P1 golden id), person_performed_action의 from_ref가 raw userId(golden person id 연결 P1). promote는 수동 트리거(자동 cron 미설정).
- 재발/이어서: 이 항목 + docs/nenova-ontology-spec.md + docs/nenova-ontology-audit.md. promote 주기실행 cron + golden id 연결(P1)이 다음 단계.

## 2026-06-29 — work-logs 버그수정 + 온톨로지 자동화/보강
- work-logs.html "건수만 있고 내용 없음" 버그(커밋 bfdeba7): 대시보드가 allTypes=1 상시사용 → daemon.update(생존신호)가 limit윈도 도배 → keyboard.chunk 밀림(DATA_CHECK §3). 수정: 전체보기=서버기본필터(keyboard/screen/analyzed/idle), 특정타입만 allTypes+type. 검증 임재용 inputText 0→80.
- 온톨로지 자동화/보강(커밋 fd51346, 98ae8eb): ① startPromoteCron — 부팅1분후+30분마다 최근2h 멱등 promote(수동 불필요, 상시최신). server.js init 배선. ② talk_triggered_action 관계 — 카톡 동작 직후 30분내 업무앱 전환=대화→작업. 검증: promote 168h→talk_triggered 596건. 전체 28,524 action / action_in_app 29,456·action_in_room 5,580·talk_triggered 596·screen_observed 983·automation 550.
- ⚠️ promote 720h(315K이벤트) 한방은 502(힙768MB) — 백필은 가벼운 창(≤168h)으로. cron은 2h라 안전.
- 직원 데이터 현황(06/29): 임재용·김빛나 정상(키보드내용+화면). **김빛나 회복**(python 미설치지만 PS폴백 312KB 실화면+키보드내용). 설연주·강현우 키보드 0(uiohook死, 명령채널 안 닿음=§13-Z, 다음 재시작/13:00·15:00 자동업데이트 회생 대기). 이름정정 반영(update-user-name pgOk=True, 김빛나 표시됨).
- Vision anal=None: 서버워커 disabled_by_flag(무과금 정책), owner PC CLI워커 필요(원격불가).
- 미완(다음): 온톨로지 golden person id 연결(P1, 현재 from_ref=raw userId), action_mentions_customer/action_updated_erp(OCR/ERP 연결).

### Vision 워커 재가동 (이 PC, 무과금 CLI)
- 요청: "비전분석 이 PC에서 워커로 작업 시작". owner PC(이 PC)에서 bin/vision-worker.js --server-queue 로 Claude CLI(Max구독) 무과금 분석.
- **★근본 막힘(비자명, 재발주의): Claude CLI OAuth 토큰 만료**(~/.claude/.credentials.json expiresAt 2026-06-22). 워커가 `claude -p`로 분석하는데 401 Invalid auth → 모든 분석 빈결과. 이 Claude Code 세션은 호스트가 토큰 갱신해줘서 되지만 **별도 spawn한 claude 서브프로세스엔 안 퍼짐**. 일반 로그인/데스크톱앱 로그인으론 standalone CLI 토큰 갱신 안 됨.
- **해결: `claude setup-token`**(헤드리스 장기토큰 생성). 일반 login 아니라 이거여야 standalone CLI(/.local/bin/claude, 워커가 쓰는 것)가 인증됨. → expiresAt 갱신, `claude -p` 이미지분석 정상.
- claude 바이너리 2개 주의: 워커는 /c/Users/USER/.local/bin/claude(2.1.173) 사용. 데스크톱앱은 Packages\Claude_...\claude-code\2.1.187. setup-token이 둘 다 쓰는 ~/.claude 토큰 갱신.
- 검증: 워커 재기동(--night 없이 즉시처리) → screen.analyzed 신규생성 확인("jaeyong lim ECOUNT ERP 구매입력 화면 일자/입고창고 채움" 등 정밀분석). vision queue 처리 중.
- 운영: 낮 즉시처리는 Max구독 쿼터 사용. 밤엔 autostart의 --night가 이어받음(setup-token으로 그것도 이제 인증됨). screen.analyzed는 ops-ontology cron(30분)이 screen_observed_action으로 자동 승격.
- 재발 시: vision/stat이 disabled_by_flag(서버워커 OFF=정상, 무과금정책)인데 anal 안 늘면 → 이 PC CLI 토큰 만료 의심 → `claude setup-token` 재실행 + 워커 재기동. 메모리 vision-cli-worker-local.

## 2026-06-29 — API 일$5 비용 출처 규명 + 차단 + 호출자별 추적기 (커밋 b3f5e41·ef4635c)
- 증상: Anthropic 콘솔 전액 **Claude Haiku 4.5**, 하루 $3~13(6/11 데몬 증가 시점부터 급증).
- **범인: src/ollama-analyzer.js** — 이름과 달리 `runAnalysis()`에서 **Haiku가 1차, Ollama는 폴백**. Railway엔 Ollama 없어 항상 Haiku. server.js `for(ev of events) ollamaAnalyzer.addEvent(ev)`로 **수신 모든 이벤트**가 큐→10건/12초마다 queryHaiku 발사 → 근무중 상시 과금.
- 차단: Haiku 1차를 `REALTIME_HAIKU=on`(또는 global._realtimeHaikuOn) + 60초 스로틀 게이트로. **기본 OFF → 과금 0**. Ollama 폴백 유지(모듈 원래 의도 복원).
- 추적기 신설 `src/llm-usage.js`: Anthropic 호출별 토큰/비용 → 테이블 orbit_llm_usage. `wrap(client,caller)`(SDK) / `record(caller,model,parsed.usage)`(raw https). 연결처: ollama-analyzer·insight-engine·auto-doctor·server-vision-worker·llm-gateway·nenova-ai(챗봇).
- API: `GET /api/costs/llm?days=14`(호출자/모델/일자별), `POST /api/costs/realtime-haiku`(master 토큰, {enabled} 런타임 on/off — 실시간 패널 복원용).
- 검증: 배포 후 /api/costs/llm `source:db` byCaller 빈 배열(=Haiku 멈춤), 토글 401(무인증)/off(인증). **최종확인=Anthropic 콘솔 24h내 일비용 하락**. byDay 별칭 day(예약어)→dt 수정(ef4635c). 메모리 api-cost-ollama-analyzer-haiku.
- 다른 Haiku4.5 호출처는 비활성/저빈도: server-vision-worker(VISION_SERVER_WORKER off), auto-doctor(AUTODOCTOR_CLAUDE off, 죽은PC만), insight-engine(24h), process-mining(온디맨드).

## 2026-06-29 — 데이터 신선도 스냅샷 (작업내역 확인 범위)
- /api/admin/pc-list 기준 **실데이터 06-29 16:31 KST까지 실시간 유입**(이 시각 기준 방금 전까지 활성).
- 활성 PC(오늘 16:1x~16:31): T09911T(강현우 32,727)·S4S2HMU(owner임재용 204,839)·NENOVA(김빛나 3,724)·NEONVA(설연주 295)·DESKTOP-CAA5TA1(현욱 30,594)·NENOVA2025(10,705).
- ⚠️ DESKTOP-L0C2IOT(MNMSAQJD…) last_seen="9024-09-21" = 해당 PC 시계 미래로 깨짐(타임스탬프 오염, 집계 왜곡 가능 — 점검대상).
- 일부 user_id가 여러 hostname에 중복(예: MNH03H… owner가 S4S2HMU/nenova/L0C2IOT/NENOVA2025) = 같은 계정 다PC 잔재. 오전 07:xx까지만 찍힌 항목은 그 조합이 오전 후 비활성.

## 2026-06-29 — 업무 흐름 청사진(옵시디언 그래프 뷰) V1 구현·배포·검증 (커밋 b83f697→9ac5194)
**목표**: 팔란티어식 "숫자 아닌 흐름" 뷰. 미구현 재설계(ORBIT_3D_REDESIGN_GUIDE.md, 옵시디언×3D)를 기존 온톨로지(unified_events+ops_relation+orbit_entity_golden)로 채워 완성. 줌3단(회사맵/직원/업무단위)+핸드오프 엔진. plan: peppy-swinging-goblet.md.
- **P1 핸드오프 엔진** `src/flow-handoff.js` `enrichHandoff(pool,hours)` — promote() 직후 호출(ops-ontology.js /promote+cron). 룩백 min72h(짝 누락 방지), 멱등. 신규 rel 3종:
  - action_mentions_customer: Action.data(activity/screen/room)→거래처 골든(N.findCandidates score≥0.85). 재사용 src/intelligence/entity-resolution(korean-normalizer/bootstrap-customer). 검증: "그린화원" 등 정확 매칭.
  - action_handoff: 공유키(cust/order≥5자리/doc파일명/**room=카톡방**)+다른사람+24h내 인접쌍. **room 키가 핵심**(같은 톡방=협업맥락). 검증: **설연주→강현우** 등 11쌍.
  - action_updated_erp: ERP앱 액션+키→ErpOutcome.
- **P2 Flow API** `routes/flow-map.js` mount /api/flow (server.js). 인증=intelligence-golden 패턴(MASTER_TOKEN orbit_9679 또는 ?token, **resolveAdmin 아님**—그건 env ADMIN_TOKENS만 받음). 액션id `act:{userId}:{sec}`에서 userId 파싱해 핸드오프 롤업(조인불필요). 엔드포인트: /company(별자리+핸드오프 overlay) /employee?userId=&hours= /workunit?customer=&order= /people. 검증: company 노드22/엣지30, employee(강현우)400노드.
- **P3 프론트** `public/graph.html`+`public/js/graph-shell.js` — UMD force-graph(2D)/3d-force-graph(3D 토글), 줌3단, 신뢰도 고리(녹1.0/황0.67/회0.34), 핸드오프 흐름선, 노드클릭→OAG 패널(/api/ops-ontology/actions/:id/context). 브라우저 검증완료(스샷): 회사 별자리 렌더, 강현우 직원흐름 400노드, 액션클릭→Excel 작업 증거패킷+관계 표시.
- **재발/한계**: ① 핸드오프는 데이터 희소—owner 외엔 vision/keyboard 약해 처음 0이었음. 336h promote+room키 후 11쌍. 설연주/강현우 keyboard死 회복되면 더 늘어남. ② /employee 기본선택이 활동최다(MN90A…8463, 06-18마지막)면 168h창 밖→0노드. 최근활동순 정렬 개선 여지. ③ 회사맵에서 일부 거래처명(정화원예 등)이 라벨겹침/엔티티오분류로 보일 수 있음(entity-resolution 후속). ④ promote 720h=OOM, ≤168h. ⑤ admin token=env ADMIN_TOKENS(로컬 ~/.orbit-config.json token=orbit_1f4df8…이 프로덕션도 통함), flow API는 orbit_9679로 접근.
- 범위밖(후속): workunit 선형DAG 레이아웃, 기존페이지 graph셸 흡수(지침 PhaseB~D), 노드 클러스터링.

## 2026-06-29 — 주기 운영 에이전트 파이프라인 (owner PC CLI 무과금) (커밋 70b0082)
사용자 요청: 데이터구조를 에이전트구성에서 가져오고, 주기적 업데이트. 확인결과 **흐름 그래프는 이미 30분 cron(promote+enrichHandoff)으로 자동갱신**되나, nenova 4에이전트(.claude/agents/nenova-*, data-fusion/forecaster/cross-validator/ops-orchestrator)는 세션 수동호출만이라 예측·병목·교차검증 층이 주기화 안 됨. 결정: **owner PC Claude CLI(무과금)로 에이전트 파이프라인 주기 실행**(Vision워커 패턴), 산출물 전부(예측/병목/부하/자동화/교차검증/source_disagreement) 흐름 뷰에 표시.
- **서버**(routes/flow-map.js): GET /api/flow/ops-input(융합 작업단위 번들=data-fusion 산출물, units160·loads·handoffs) + POST/GET /api/flow/ops-report(orbit_ops_report 테이블).
- **워커** bin/ops-agent-worker.js: ops-input fetch → 합성 프롬프트(orchestrator+forecaster+validator)를 claude CLI에 **stdin**으로(arg길이제한 회피) → JSON 파싱 → ops-report POST. 4h 루프(--once 지원). CLAUDE_CLI=where claude(C:\Users\USER\.local\bin\claude.exe). 무과금(Max구독).
- **프론트**(graph.html): "📊 운영 인사이트" 패널 — verdict/confidence + 예측·병목·부하·자동화·교차검증·원천불일치 + "N분 전 갱신".
- **검증완료(브라우저 스샷)**: 워커 1회 62초 무과금 실행 → verdict WARN 0.55, 예측4·병목2·자동화4 생성·저장. 패널 렌더: "회계분개 jaeyong 1인 집중·handoff0→보조담당 지정", "Excel주문 ㅋㅋ 단독→강현우 이관검토" 등 증거기반(vision 4회, units503). 교차검증이 핸드오프 희소를 정확히 WARN.
- **상시화**: bg 루프 가동중(~/.orbit/ops-agent.log, 4h). 런처 ~/.orbit/ops-agent-start.ps1 + ops-agent-hidden.vbs. **HKCU\Run OrbitOpsAgent=wscript ops-agent-hidden.vbs 등록완료(사용자 승인)** → 부팅 자동재시작. 기존 OrbitVisionWorker와 동일 패턴.
- 한계: ops-input handoff는 입력창(72h)내만 → 0일 수 있음(company뷰는 전체라 11). confidence 0~1로 출력됨(스키마 0~100 의도였으나 표시 무방). CLI 토큰 만료시 워커 빈출력([[vision-cli-worker-local]] setup-token 동일 이슈).

## 2026-06-29 — MOYI 플랫폼화: 설치프로그램 set 설계 + I0(수집 동의) (커밋 900c7a0)
- 흐름 대시보드 1시간 자동새로고침(선택유지, 커밋 65e1d20), 재설치 "토큰 무효" 오탐 수정(810ef60, [[orbit-daemon-install-deploy]]).
- **설치프로그램 set 설계**: C:\Users\USER\MOYI_PLATFORM_PLAN.md §9. 핵심: 실제 설치물=MOYI Agent(PC EXE)+MOYI Talk(모바일/PWA), 나머지 웹. 테넌트 부트스트랩 체인(가입→온보딩→설치링크?t=→Agent설치[동의]→Talk→Map). **이미 Inno Setup EXE 경로 반쯤 존재**(setup/orbit-setup.iss+build-installer.ps1+stub.cs) → 완성+코드사이닝만. 갭: tenant_id·동의·collection_profile·서명.
- **동의≠인증서 확정**: 동의=개인정보 고지·법적(설치 내 간단동의). 인증서=SmartScreen/Defender 신뢰(외부 판매 시 필요, 지금 파일럿은 현 web-.bat로 불필요). 사용자 결정: 간단동의, 인증서 나중.
- **I0 구현**: setup/install-open.ps1에 이름입력 전 [수집 동의 안내](항목·목적·은행제외·마스킹·열람/정지/삭제 권리)→동의(Enter)/거부(N 취소). server.js auto-register가 consent/consentAt를 orbit_pc_links.metadata 감사기록에 저장(재사용·신규 양경로). 검증: PS파서 통과, 배포 후 /setup/install-open.ps1에 문구 확인, 동의 auto-register ok:True.
- **다음(미완)**: T0 테넌트 격리(promote/flow/ops 쿼리에 tenant_id 필터 — 2호 거래업체 전 필수, [[flow-blueprint-obsidian-graph]] 격리갭). 설치링크?t=→config tenantId→hook 플러밍은 T0와 묶어서. 서명EXE+인증서는 외부판매 시점.
