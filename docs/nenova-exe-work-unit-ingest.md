# Nenova.exe 작업 단위 수집 계약

이 문서는 직원 PC의 `nenova.exe`, 마우스/키보드 이벤트, 카카오톡/카카오워크 대화 기록을 `nenovaweb`의 직원 작업 단위 화면으로 보내는 최소 계약입니다.

## 수집 목적

- 직원 계정별 작업 영역을 분 단위로 확인합니다.
- 카카오톡/카카오워크 대화가 어떤 작업을 만들었는지 확인합니다.
- 반대로 작업 뒤 어떤 대화가 이어졌는지 확인합니다.
- PC 앱, 창 제목, 클릭 수, 화면 근거까지 묶어 3차 교차검증합니다.

## 엔드포인트

`nenova.exe`가 수집한 원본 PC 이벤트는 먼저 이 엔드포인트로 보냅니다.

```http
POST /api/nenova-exe/events
Content-Type: application/json
```

이 엔드포인트는 원본 이벤트를 `nenova-erp-ui/data/nenova-exe-events.json`에 저장하고, 동시에 직원 워크플로우 화면에서 볼 수 있는 작업 단위로 변환해 내부적으로 `/api/work-units`에 동기화합니다.

원본 이벤트 예시:

```json
{
  "id": "nx-20260524-001",
  "type": "mouse.chunk",
  "sessionId": "sess-20260524-seol-001",
  "timestamp": "2026-05-24T15:10:00+09:00",
  "hostname": "NENOVA2025",
  "userEmail": "worker@example.com",
  "data": {
    "app": "nenova.exe",
    "processName": "nenova.exe",
    "executablePath": "C:\\Nenova\\nenova.exe",
    "windowTitle": "견적관리 - 세종상사",
    "mouseClicks": 18,
    "mouseRegions": {
      "quoteGrid": 12,
      "saveButton": 1
    },
    "screenSummary": "세종상사 견적 단가표 입력 화면"
  }
}
```

지원하는 주요 원본 필드:

- `id`, `type`, `eventType`, `sessionId`, `parentEventId`, `timestamp`
- `userId`, `userEmail`, `employeeName`, `accountId`, `hostname`, `deviceId`
- `data.app`, `app`, `processName`, `exe`, `executablePath`
- `windowTitle`, `activeWindowTitle`, `activeWindow.title`, `activeWindow.processName`
- `mouseClicks`, `clickCount`, `recentClicks`, `mouseRegions`, `mousePositions`
- `keyboardCount`, `keyCount`, `keystrokes`, `textLength`
- `screenSummary`, `visionSummary`, `screenText`, `ocrText`, `data.screen.summary`
- `startedAt`, `endedAt`, `period.start`, `period.end`, `durationSec`, `activeSeconds`

자주 쓰는 이벤트 타입:

```text
active_window
mouse.chunk
keyboard.chunk
screen.capture
screen.analyzed
clipboard.change
recorder.click
```

정규화 결과는 다음 규칙으로 생성합니다.

- 앱/프로세스/실행 경로에 `nenova.exe`가 있으면 source를 `nenova.exe`로 저장합니다.
- 그 외 PC 이벤트는 source를 `PC`로 저장합니다.
- hostname, email, accountId, KakaoWork userId로 직원 계정을 매칭합니다.
- 화면 제목, 화면 요약, 앱 이름에서 견적/계약/프로젝트/할일/정산/재고/보고/AI검토/고객응대 카테고리를 추론합니다.
- `session_id`, `hostname`, `process`, `executable`, `active_window`, `mouse_clicks`, `keyboard_count`, `screen_summary`를 교차검증 evidence로 남깁니다.
- 새 작업 단위의 `validationStatus`는 우선 `검증대기`이며, 이후 카톡/카카오워크/ERP/구글시트 근거와 연결해 `부분일치` 또는 `일치`로 보정합니다.

원본 이벤트가 너무 잘게 쌓일 때는 세션 병합 후보를 봅니다.

```http
GET /api/nenova-exe/sessions?date=2026-05-24&gapMin=5&limit=50
```

세션 병합은 `accountId`, `sessionId`, `category`, `appName` 기준으로 묶고, 이벤트 간격이 `gapMin`분을 넘으면 다른 세션으로 나눕니다. 하나라도 `nenova.exe` 이벤트가 포함되면 세션 source는 `nenova.exe`로 봅니다.

화면에서 후보를 확인한 뒤 저장하거나, API로 바로 저장할 수 있습니다.

```http
POST /api/nenova-exe/sessions
Content-Type: application/json

{
  "sessionIds": ["NXS-nenova-sales-support-sul-yeonju-sess-20260524-seol-001-20260524061000-1"],
  "gapMin": 5,
  "limit": 50
}
```

저장하면 `NX-SESSION-...` 작업 단위가 `/api/work-units`에 들어갑니다. 이 작업 단위는 원본 이벤트 목록, 클릭 합계, 키보드 합계, 화면 요약 개수, 세션 시간을 evidence로 남깁니다.

이미 정규화된 작업 단위는 아래 엔드포인트로 직접 보낼 수도 있습니다.

```http
POST /api/work-units
Content-Type: application/json
```

개발 서버 기준:

```text
http://localhost:3000/api/work-units
```

수신 데이터는 `nenova-erp-ui/data/work-units.json`에 저장됩니다. 이 파일은 로컬 운영 데이터이므로 Git에는 올리지 않습니다.

카카오톡 원본 메시지는 별도 엔드포인트로 먼저 저장할 수 있습니다.

```http
POST /api/kakaotalk/messages
Content-Type: application/json
```

단건:

```json
{
  "id": "KT-20260524-001",
  "room": "대한상사",
  "sender": "김철수 과장",
  "sentAt": "2026-05-24T09:07:00+09:00",
  "text": "6월 단가표 오늘 받을 수 있을까요?"
}
```

카카오톡 내보내기 텍스트도 `rawText`로 보낼 수 있습니다.

```json
{
  "room": "대한상사",
  "rawText": "--------------- 2026년 5월 24일 일요일 ---------------\n[김철수 과장] [오전 9:07] 6월 단가표 오늘 받을 수 있을까요?"
}
```

저장된 카카오톡 메시지와 카카오워크 콜백 이벤트를 작업 단위와 연결하는 후보는 다음에서 확인합니다.

```http
GET /api/work-units/talk-candidates
```

이 후보 API는 `data/kakaotalk-messages.json`과 `data/kakaowork-events.json`을 함께 읽습니다. `KakaoTalk`/`KakaoWork` 메시지를 시간차, 카테고리, 내부 계정, 대화방명, 세션 작업 단위 여부로 점수화합니다. 카카오워크 메시지 자체가 만든 work unit은 후보 목록에서 제외하고, PC/nenova.exe/세션 작업 단위를 우선 매칭합니다.

후보 확정:

```http
POST /api/work-units/talk-candidates
Content-Type: application/json

{
  "workUnitId": "WU-PC-20260524-001",
  "talkId": "KT-20260524-001",
  "note": "톡/워크 요청과 nenova.exe 견적 작업 연결"
}
```

확정하면 work unit의 `relatedTalks`, `talkRelation`, `evidence`, `validationMemo`가 갱신됩니다.

## 단건 페이로드

```json
{
  "id": "WU-PC-20260524-001",
  "type": "mouse.chunk",
  "employeeName": "설연주",
  "employeeId": "sul-yeonju",
  "accountId": "nenova:sales-support:sul-yeonju",
  "team": "영업지원",
  "workArea": "견적/거래처 단가",
  "source": "nenova.exe",
  "appName": "nenova.exe",
  "windowTitle": "견적관리 - 거래처 단가",
  "clickCount": 34,
  "clickEvidence": ["거래처 검색", "품목 행 추가", "공급가 입력", "견적 저장"],
  "category": "견적",
  "title": "대한상사 견적 단가표 입력",
  "detail": "카카오 요청 뒤 nenova.exe 견적관리에서 6월 단가표를 입력했습니다.",
  "customer": "대한상사",
  "projectId": "PRJ-20260524-001",
  "taskId": "TSK-20260524-001",
  "startedAt": "2026-05-24T09:10:00+09:00",
  "endedAt": "2026-05-24T09:32:00+09:00",
  "confidence": 88,
  "pcEvidence": ["active_app=nenova.exe", "window_title=견적관리", "mouse_clicks=34"],
  "relatedTalks": [
    {
      "source": "KakaoTalk",
      "room": "대한상사",
      "sender": "김철수 과장",
      "sentAt": "2026-05-24T09:07:00+09:00",
      "text": "6월 단가표 오늘 받을 수 있을까요?",
      "intent": "quote_request",
      "relation": "대화후작업"
    }
  ]
}
```

## 배치 페이로드

```json
{
  "units": [
    {
      "type": "keyboard.chunk",
      "employeeName": "강현우",
      "accountId": "nenova:sales-support:kang-hyunwoo",
      "appName": "nenova.exe",
      "windowTitle": "재고조회 - 유압 실린더",
      "clickCount": 18,
      "startedAt": "2026-05-24T10:05:00+09:00",
      "endedAt": "2026-05-24T10:18:00+09:00"
    }
  ]
}
```

## 정규화 규칙

- `startedAt`, `endedAt`이 있으면 실제 작업 시간으로 사용합니다.
- `type` 또는 `eventType`은 `sourceEventType`으로 저장합니다.
- `appName`, `windowTitle`, `clickCount`는 PC 작업 근거로 사용합니다.
- `relatedTalks[].relation` 값은 `대화후작업`, `작업후대화`, `동시진행`, `미연결` 중 하나입니다.
- `category`가 비어 있으면 제목, 업무영역, 앱/창 이름에서 견적/계약/프로젝트/할일/정산/재고/보고/AI검토/고객응대를 추론합니다.
- 동일 `id`가 다시 들어오면 기존 작업 단위를 덮어써서 보정합니다.

## 화면 확인

수집 뒤 `/work-units`에서 다음을 확인합니다.

- 직원/계정별 업무영역
- 클릭/PC 작업 근거
- 카카오톡/카카오워크 대화 매칭
- 대화후작업, 작업후대화, 동시진행 분류
- 3차 검증 메모와 다음 액션

## Process Mining 브릿지

기존 Orbit/PC 수집 이벤트에서 작업 단위 후보를 만들 때는 다음 엔드포인트를 사용합니다.

```http
GET /api/mining/work-units?userId={userId}&date=2026-05-24&days=1&limit=50
```

이 엔드포인트는 `keyboard.chunk`, `mouse.chunk`, `screen.capture`, `screen.analyzed`, `clipboard.change`, `recorder.click` 이벤트를 앱 블록으로 묶고, 같은 30분 창 안의 카카오톡 이벤트를 `relatedTalks`로 붙입니다.

네노바웹으로 바로 밀어 넣을 때는 다음 엔드포인트를 사용합니다.

```http
POST /api/mining/work-units/push
Content-Type: application/json

{
  "userId": "nenova:sales-support:sul-yeonju",
  "date": "2026-05-24",
  "days": 1,
  "limit": 50,
  "targetUrl": "http://localhost:3000/api/work-units"
}
```

`targetUrl`이 없으면 `NENOVA_WORK_UNITS_URL` 환경변수를 보고, 그것도 없으면 `http://localhost:3000/api/work-units`로 보냅니다.
