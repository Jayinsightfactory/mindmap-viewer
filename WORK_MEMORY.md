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
