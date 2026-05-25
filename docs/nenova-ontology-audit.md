# Nenova Ontology Audit

Date: 2026-05-25 KST

## 결론

Nenova/Orbit에는 온톨로지 개념이 이미 들어와 있다. 다만 현재는 세 갈래로
흩어져 있다.

1. 개발 파일 온톨로지: `routes/ontology.js`
2. 회사 운영 온톨로지: `src/company-ontology.js`, `src/company-ontology-pg.js`
3. 실세계 엔티티 해소/골든 레코드: `unified_events`, `orbit_entity_golden`,
   `routes/intelligence-golden.js`

우리 기획의 핵심은 2번과 3번이다. 1번은 코드베이스 관리용이라 제품 온톨로지와
이름이 겹칠 뿐, 직원 업무/주문/거래처/카카오/PC 작업을 설명하는 본체는 아니다.

## 현재 접목된 방식

### 1. 회사 운영 객체 모델

파일:

- `src/company-ontology.js`
- `src/company-ontology-pg.js`
- `routes/company.js`

객체:

- Company
- Department
- Employee
- Process
- System
- Issue/Diagnosis
- Activity
- Benchmark

관계:

- `company_links`
- `belongs_to`
- `depends_on`
- `collaborates`
- `uses_system`

역할:

- 컨설팅/진단형 회사 OS의 기본 객체 모델.
- 회사, 부서, 직원, 프로세스, 시스템을 하나의 그래프로 만들 수 있다.

### 2. 통합 이벤트 버스

파일:

- `migrations/0010_unified_events.sql`
- `src/event-bus.js`
- `src/intelligence/adapters/*`

역할:

- Orbit PC 데이터, Nenova ERP, Kakao/Nenova agent, AI trainer 데이터를
  `unified_events`로 모은다.
- 온톨로지 객체가 되기 전의 원천 증거 레이어다.

현재 의미:

- "누가 무엇을 했는가"를 판단하기 위한 원본 이벤트 저장소.
- 아직 모든 이벤트가 표준 Work Unit/ontology relation으로 승격되지는 않는다.

### 3. 골든 레코드와 엔티티 해소

파일:

- `migrations/0011_entity_golden.sql`
- `routes/intelligence-golden.js`
- `src/intelligence/entity-resolution/*`
- `public/admin-intelligence-golden.html`

객체:

- Person
- Customer
- Document
- Task

역할:

- 여러 소스가 가리키는 같은 실세계 객체를 하나로 합친다.
- 예: PC hostname, ERP user id, Kakao room/user가 같은 사람/거래처인지 매칭.

신뢰도 모델:

- 1소스: 추정
- 2소스: 확인
- 3소스: 골든 레코드

### 4. Work Unit 교차검증

파일:

- `nenova-erp-ui/src/app/api/work-units/route.ts`
- `nenova-erp-ui/src/app/api/work-units/talk-candidates/route.ts`
- `nenova-erp-ui/src/app/api/work-units/intake-candidates/route.ts`
- `docs/nenova-work-unit-cross-validation.md`

역할:

- `nenova.exe`, PC 이벤트, KakaoTalk/KakaoWork, ERP 상태를 직원 작업 단위로 묶는다.
- 대화후작업, 작업후대화, 동시진행, 미연결 관계를 기록한다.
- validationStatus를 일치/부분일치/충돌/검증대기로 관리한다.

현재 의미:

- 실제 업무 판단의 중심이다.
- 하지만 아직 `orbit_entity_golden`과 강하게 결합되어 있지는 않다.

### 5. Computer Use/OCR와의 접점

파일:

- `scripts/nenova-cu.js`
- `docs/nenova-computer-use-lab.md`

역할:

- OCR 결과에서 거래처, 주문번호, 품목, 수량, 화면유형, 앱유형을 추출한다.
- desktop-run/web-audit/preview로 "어디를 봤고 어디를 클릭했는지"를 남긴다.

현재 의미:

- 온톨로지로 들어갈 수 있는 증거를 만들기 시작했다.
- 아직 OCR 추출 결과가 `unified_events`, Work Unit, golden entity로 자동 승격되지는 않는다.

## 빠진 연결

### 1. 제품 온톨로지 명세가 없다

현재 객체와 관계가 코드에 흩어져 있다.

필요:

- `docs/nenova-ontology-spec.md`
- 표준 object type
- 표준 relation type
- 필수 속성
- source/provenance 규칙
- confidence 계산 규칙

### 2. Work Unit이 골든 레코드를 참조하지 않는다

Work Unit에는 `employee`, `customer`, `projectId`, `taskId`가 있으나,
`personGoldenId`, `customerGoldenId`, `taskGoldenId` 같은 안정 ID가 없다.

필요:

- Work Unit normalize 단계에서 `orbit_entity_golden` lookup.
- 실패 시 unresolved entity 후보 기록.
- 확정 시 Work Unit에 golden id 저장.

### 3. 관계 테이블이 부족하다

`company_links`는 회사 컨설팅 객체용이고, `orbit_entity_golden`은 객체 매칭용이다.
하지만 실무 관계를 표현하는 표준 relation store가 약하다.

필요 관계:

- `person_performed_work_unit`
- `work_unit_mentions_customer`
- `talk_triggered_work_unit`
- `work_unit_updated_erp_object`
- `screen_observed_work_unit`
- `ocr_extracted_entity`
- `automation_candidate_for_process`
- `computer_use_action_verified_by_screen`

### 4. OCR/Computer Use 결과가 ontology evidence로 승격되지 않는다

현재 OCR은 JSON artifact로 남는다.

필요:

- OCR 결과를 `unified_events`에 `source='computer-use-lab'`로 publish.
- 추출 필드가 Person/Customer/Task 후보를 만들게 연결.
- preview frame도 evidence/provenance로 남김.

### 5. `routes/ontology.js` 명칭이 혼란스럽다

이 라우트는 개발 파일 의존성/AI 히스토리 그래프다.
회사 업무 온톨로지와 구분해야 한다.

필요:

- `/api/code-ontology` 또는 `/api/dev-ontology`로 의미 분리.
- 회사 업무용은 `/api/ops-ontology` 같은 별도 이름 사용.

### 6. 온톨로지 기반 에이전트 컨텍스트가 약하다

에이전트가 답할 때 "회사 온톨로지 객체 + 관계 + 근거"를 일관되게 주입하는
OAG(Ontology Augmented Generation) 계층이 아직 얇다.

필요:

- 질문/작업 목표에서 관련 Person/Customer/Work Unit/Process를 조회.
- LLM에 원문 이벤트가 아니라 정리된 ontology packet을 제공.
- 충돌/미확인 객체는 답변에서 확정하지 않도록 강제.

## 우선순위

### P0. 온톨로지 명세 고정

가장 먼저 `nenova-ontology-spec.md`를 만든다.
이게 없으면 앞으로 OCR, RPA, Work Unit, Kakao, ERP가 계속 제각각 필드를 만든다.

### P1. Work Unit에 golden id 연결

작업 단위가 직원/거래처/ERP 객체의 안정 ID를 가져야 한다.
이게 되어야 "회사 전체 업무를 하나의 UI로 운영"할 수 있다.

### P2. Computer Use/OCR evidence publish

`nenova-cu`의 OCR/클릭/프리뷰 결과를 `unified_events`로 올리고,
Work Unit 후보와 연결해야 한다.

### P3. 표준 relation store 추가

객체가 아니라 객체 사이의 관계를 1급 데이터로 저장해야 한다.
그래야 flow, process, 자동화 후보, 책임자, 병목이 안정적으로 나온다.

### P4. Ops Ontology API 추가

관리자 UI와 에이전트가 같은 API를 보게 한다.

예:

- `GET /api/ops-ontology/entities?type=customer`
- `GET /api/ops-ontology/work-units/:id/context`
- `GET /api/ops-ontology/relations?entityId=...`
- `POST /api/ops-ontology/evidence`

## 최종 판단

온톨로지는 이미 "기획 문구"가 아니라 코드에 들어와 있다.
하지만 아직 하나의 실행 표준은 아니다.

현재 상태는:

- 회사 객체 모델: 있음
- 통합 이벤트 버스: 있음
- 골든 레코드: 있음
- Work Unit: 있음
- OCR/Computer Use 증거: 시작됨
- 이들을 하나의 ontology contract로 묶는 계층: 부족

따라서 다음 개발은 기능 추가보다 먼저 "객체/관계/증거/신뢰도 표준"을 고정하는
작업이 맞다.
