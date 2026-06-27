# Nenova Ops Ontology Spec (P0 표준)

Date: 2026-06-25 KST
Status: v1 (실행 표준 — 이후 모든 소스는 이 스펙의 object/relation/provenance/confidence를 따른다)

이 문서는 `docs/nenova-ontology-audit.md`의 P0(명세 고정)를 충족한다.
목적: 화면/키보드/카톡/마우스/ERP 관찰을 **하나의 표준 객체·관계·증거·신뢰도**로 승격해
"오늘 직원이 한 작업"이 온톨로지 인스턴스로 자동 채워지게 한다.

---

## 1. 레이어

```
원천 증거 (events 테이블: keyboard.chunk / screen.analyzed / mouse.chunk / clipboard.change / *.detected)
   │  승격(promote)
   ▼
온톨로지 인스턴스
  - 객체(Action) → unified_events (type='work.action', source='orbit')
  - 객체(Person/Customer/Document/Task) → orbit_entity_golden (기존)
  - 관계 → ops_relation (신규, 1급 데이터)
   │
   ▼
조회 (ops-ontology API) → 대시보드 / 에이전트(OAG)
```

원천 증거는 삭제/변형하지 않는다. 승격은 증거를 가리키는 새 객체·관계를 만들 뿐이다(provenance 보존).

---

## 2. 표준 객체 타입 (object type)

| 타입 | 저장 | 핵심 속성 | 설명 |
|---|---|---|---|
| `Action` | unified_events(work.action) | app, room, activity, screen, verified, sources[], typedChars, clicks, durationSec | 한 직원의 한 시각(동작) 단위 — 융합 결과 |
| `Person` | orbit_entity_golden(person) | name, aliases, orbitUserId, hostname, kakaoUserId, team | 직원(실세계 1인) |
| `Customer` | orbit_entity_golden(customer) | name, aliases | 거래처 |
| `Document` | orbit_entity_golden(document) | name, kind | 견적/발주/카탈로그 등 |
| `Task` | orbit_entity_golden(task) | name, status | ERP 작업/할일 |
| `App` | (관계의 endpoint, 값 참조) | name | nenova ERP / 카카오톡 / Excel 등 |
| `Room` | (관계의 endpoint, 값 참조) | name | 카톡/워크 톡방명 |
| `Process` | company-ontology(Process) | name | 업무 프로세스(주문입력 등) |

App/Room/Process는 별도 golden을 강제하지 않고 관계의 `to_ref`(문자열 키)로 시작한다(점진적 승격).

---

## 3. 표준 관계 타입 (relation type) — `ops_relation`

1급 데이터. 객체 사이 관계를 직접 저장한다(audit P3).

| rel_type | from → to | 의미 | 1차 근거 |
|---|---|---|---|
| `person_performed_action` | Person → Action | 누가 그 동작을 했나 | user_id |
| `action_in_app` | Action → App | 어떤 앱/시스템에서 | data.app |
| `action_in_room` | Action → Room | 어떤 톡방에서 | windowTitle(kakao) |
| `action_typed_text` | Action → (text evidence) | 무슨 내용을 입력 | inputText(두벌식) |
| `screen_observed_action` | Action → (vision evidence) | 화면해독이 본 것 | screen.analyzed |
| `talk_triggered_action` | Action(talk) → Action(work) | 대화가 작업을 유발 | 시간창 선행 kakao |
| `action_mentions_customer` | Action → Customer | 거래처 언급 | OCR/text 추출 |
| `action_updated_erp` | Action → Task/Document | ERP 객체 갱신 | *.detected |
| `automation_candidate_for_process` | Action → Process | 자동화 후보 | visionAutomatable |

---

## 4. Provenance (출처/증거)

모든 객체·관계는 다음을 가진다.

- `source` ∈ `{ orbit, erp-ui, nenova-agent, ai-trainer, computer-use-lab }`
- `evidence` (JSONB): 원천 event id 배열 + 어떤 필드가 근거였는지
  - 예: `{ "events": ["kb-1782..","sa-1782.."], "fields": ["inputText","visionScreen"] }`
- 승격은 멱등(idempotent): 같은 원천 증거는 같은 객체/관계 id로 재승격(중복 방지). Action id = `act:{userId}:{startEpoch}`.

원천을 못 가리키는 객체·관계는 만들지 않는다(추측 금지).

---

## 5. Confidence (신뢰도)

골든 등급과 동일 체계(`orbit_entity_golden`와 호환).

| 독립 소스 수 | confidence | 등급 |
|---|---|---|
| 1 | 0.34 | 추정 |
| 2 | 0.67 | 확인 |
| 3+ | 1.00 | 골든 |

- Action의 소스 = 그 동작에 기여한 센서 종류 수 (screen/keyboard/mouse/clipboard/vision/business-event).
- 관계의 confidence = 양 끝 객체 confidence와 관계 근거 수의 함수(최소 0.34).
- `verified = confidence >= 0.67` (2+소스 일치).
- 충돌(같은 시각 상반 근거)은 `confidence`를 낮추고 답변에서 확정 금지.

---

## 6. 멱등 승격 규칙

- Action id: `act:{userId}:{startEpochSec}` (시간창 시작 기준) → 재실행해도 동일 id upsert.
- ops_relation id: `rel:{relType}:{fromId}:{toRef}` 해시 → 중복 방지.
- 승격 범위: `POST /api/ops-ontology/promote?hours=N` (기본 24h). 같은 구간 재실행 안전.

---

## 7. 조회 계약 (ops-ontology API)

| 엔드포인트 | 용도 |
|---|---|
| `POST /api/ops-ontology/promote?hours=N` | 원천 → 객체/관계 승격(멱등) |
| `GET /api/ops-ontology/stats` | 객체/관계 수, 타입 분포 |
| `GET /api/ops-ontology/entities?type=person\|customer` | 골든 객체 목록 |
| `GET /api/ops-ontology/relations?fromId=&relType=&limit=` | 관계 질의 |
| `GET /api/ops-ontology/actions/:id/context` | 한 Action + 모든 관계 + 증거(OAG 패킷) |

에이전트는 원문 이벤트가 아니라 `actions/:id/context`가 주는 **정리된 ontology packet**을 받는다(OAG). 충돌/미확인 객체는 확정하지 않는다.

---

## 8. 비목표 (이번 v1에서 안 하는 것)

- RDF/SPARQL 같은 형식 온톨로지 엔진 (관계는 관계테이블로 충분)
- 모든 과거 이벤트 일괄 승격 (기본 최근 24h, 필요 시 hours 확장)
- Work Unit(nenova-erp-ui)과의 강결합 — golden id 공유로 느슨하게 연결(P1 후속)
