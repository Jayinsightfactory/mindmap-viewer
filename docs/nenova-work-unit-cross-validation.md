# Nenova Work Unit Cross Validation

Date: 2026-05-24 KST

## Purpose

Nenova staff work in different accounts and responsibility areas. A useful ERP/AI workflow cannot only count app usage. It needs to show:

- which employee account worked,
- which work area the account belongs to,
- what PC/app/click activity happened,
- which KakaoTalk/KakaoWork conversation happened before, during, or after the work,
- whether the ERP state supports the same conclusion.

## Web Implementation

`nenovaweb` now has a work-unit view:

- Page: `/work-units`
- Data store: `nenova-erp-ui/src/lib/store.ts`
- Ingestion foundation: `POST /api/work-units`
- ERP merge candidates: `GET /api/work-units/intake-candidates`
- AI context: `/api/assistant` receives `getErpSnapshot()`, which includes work-unit summaries.

## Work Unit Shape

Important fields:

| Field | Meaning |
| --- | --- |
| `employee` / `accountId` | The person and account identity |
| `team` / `workArea` | Responsibility area for that account |
| `startedAt` / `endedAt` / `durationMin` | Work time window |
| `appName` / `windowTitle` | PC work context |
| `clickCount` / `clickEvidence` | Click/action evidence |
| `relatedTalks` | KakaoTalk/KakaoWork messages near the work |
| `talkRelation` | `대화후작업`, `작업후대화`, `동시진행`, `미연결` |
| `pcEvidence` | Screen/app/keyboard/mouse evidence |
| `validationStatus` | `일치`, `부분일치`, `충돌`, `검증대기` |

## Matching Logic

1. Fix employee account and work area first.
2. Collect PC work events from `nenova.exe`, screen activity, click count, and window title.
3. Match KakaoTalk/KakaoWork messages within 30 minutes before, during, and after the work.
4. Check whether customer, project, task, quote, or invoice exists in `nenovaweb`.
5. Assign validation:
   - `일치`: Kakao + PC + ERP all support the same work unit.
   - `부분일치`: two sources match, one is missing.
   - `충돌`: sources disagree.
   - `검증대기`: only one source exists.

## ERP Intake Candidate Scoring

`GET /api/work-units/intake-candidates` compares file-backed work units with ERP intake drafts.

Score signals:

- `same_kakaowork_event`: work unit ID and intake `sourceEventId` point to the same KakaoWork message.
- `same_account`: both records resolve to the same internal `accountId`.
- `same_category`: quote/task/project/finance/inventory category matches.
- `same_customer`: extracted customer names match.
- `within_30min` or `within_3h`: event time is close enough for operational review.
- `erp_already_linked`: intake was already converted into an ERP object.

Recommendations:

- `85+`: automatic merge candidate.
- `60-84`: review before merge.
- Below threshold: low priority and hidden from the first list.

## Confirming A Candidate

`POST /api/work-units/intake-candidates` stores the selected ERP intake evidence back into the work unit.

Request:

```json
{
  "workUnitId": "KW-WU-...",
  "intakeId": "ERP-IN-KW-...",
  "note": "ERP 수신함 병합 확정"
}
```

Effect:

- `validationStatus` becomes `일치` for high-score candidates and `부분일치` otherwise.
- `evidence` receives `erp_intake=...`, `erp_intake_status=...`, `erp_merge_score=...`, and `erp_merge_reason=...`.
- Missing `customer`, `taskId`, or `projectId` can be filled from the intake item when available.

## Example Payload

```json
{
  "employeeName": "설연주",
  "accountId": "nenova:sales-support:sul-yeonju",
  "team": "영업지원",
  "workArea": "견적/거래처 단가",
  "source": "nenova.exe",
  "appName": "nenova.exe",
  "windowTitle": "견적관리 - 거래처 단가",
  "clickCount": 34,
  "clickEvidence": ["거래처 검색", "품목 행 추가", "공급가 입력"],
  "category": "견적",
  "title": "대한상사 견적 단가표 입력",
  "startedAt": "2026-05-24T09:10:00+09:00",
  "endedAt": "2026-05-24T09:32:00+09:00",
  "taskId": "TSK-20260520-002",
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
