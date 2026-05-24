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
