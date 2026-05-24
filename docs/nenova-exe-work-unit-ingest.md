# Nenova.exe 작업 단위 수집 계약

이 문서는 직원 PC의 `nenova.exe`, 마우스/키보드 이벤트, 카카오톡/카카오워크 대화 기록을 `nenovaweb`의 직원 작업 단위 화면으로 보내는 최소 계약입니다.

## 수집 목적

- 직원 계정별 작업 영역을 분 단위로 확인합니다.
- 카카오톡/카카오워크 대화가 어떤 작업을 만들었는지 확인합니다.
- 반대로 작업 뒤 어떤 대화가 이어졌는지 확인합니다.
- PC 앱, 창 제목, 클릭 수, 화면 근거까지 묶어 3차 교차검증합니다.

## 엔드포인트

```http
POST /api/work-units
Content-Type: application/json
```

개발 서버 기준:

```text
http://localhost:3000/api/work-units
```

수신 데이터는 `nenova-erp-ui/data/work-units.json`에 저장됩니다. 이 파일은 로컬 운영 데이터이므로 Git에는 올리지 않습니다.

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

