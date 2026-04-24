# Intelligence Layer — 사용자 데이터 통합 인텔리전스

3소스(mindmap PG · nenova ERP · nenova-agent 카톡 분석)를 융합해
**"누가 무엇을 회사 흐름의 어디서 했는가"**를 정확히 파악.

> 배경 사례·아키텍처 패턴은 메모리 `project_user_intelligence_architecture.md` 참조.
> Palantir Ontology + Senzing ER + Celonis Process+Task Mining + MS Viva Insights 합성.

---

## 5계층 아키텍처

```
[5] Workshop UI — 사람 클릭 → 활동·고객·트랜잭션 드릴다운
[4] Workflow Discovery — 시퀀스→프로세스 변종→역할(개시/처리/승인/수신)
[3] Activity Abstraction — 세션→Claude 의미라벨 (shadow, company-ontology.json)
[2] Entity Resolution — Person/Customer/Doc/Task 골든 레코드 (확률 매칭)
[1] Source Adapters — mindmap / nenova-erp / nenova-agent 정규화
```

## 기존 자산 (재사용)

| 자산 | 위치 | 역할 |
|---|---|---|
| `unified_events` 테이블 | `migrations/0010_unified_events.sql` | Layer 1 통합 이벤트 버스 (이미 존재) |
| `event-bus.js` | `src/event-bus.js` | publish/query/SSE/PG NOTIFY (이미 완성) |
| 9 PC ↔ 사용자 매핑 | `orbit_pc_links` 테이블 | Person resolution 시드 데이터 |
| `company-ontology.js` | `src/company-ontology-pg.js` | Layer 3 분류 사전 (Phase 0 plan) |
| `/admin/analytics`, `/api/analytics/*` | mindmap-viewer | Layer 5 UI 베이스 |

## 본 디렉토리 구조

```
src/intelligence/
├── README.md                    이 문서
├── adapters/
│   ├── erp-client.js            JWT 로그인 + nenova-erp-ui Railway API 호출 래퍼
│   ├── erp-publisher.js         /api/{orders,shipment,stats} → publish('erp-ui', ...)
│   ├── agent-publisher.js       /api/agent/{intelligence,issues} → publish('nenova-agent', ...)
│   └── orbit-publisher.js       기존 PG orbit_* 테이블 → publish('orbit', ...)
└── entity-resolution/           (Phase B에서 구현)
```

마이그레이션은 기존 `mindmap-viewer/migrations/`에 통합:
- `0010_unified_events.sql` — Layer 1 (기존)
- `0011_entity_golden.sql` — Layer 2 (신규, 본 작업)

## 3소스 신뢰도 모델

- 1소스 → 추정 (회색)
- 2소스 → 확인 (노랑)
- **3소스 정렬 → 골든 레코드 (녹색) ← 학습 데이터로 사용**

**인과 체인**: A(PC)→B(카톡)→C(ERP) — B가 A와 C의 다리.

## 5단계 롤아웃 (현재 단계: Phase A)

| Phase | 기간 | 목표 | 산출 |
|---|---|---|---|
| **A. 소스 어댑터** | 1주 | 3소스 read-only 정규화 → unified_events | publisher 3종 |
| B. 엔티티 해소 | 2주 | Person/Customer/Doc 매칭 + 골든 | `orbit_entity_golden` |
| C. 활동 분류 (Shadow) | 4주 | Claude 세션→활동 라벨, **실행 X** | 카테고리별 정확도 % |
| D. 워크플로우 발견 | 2주 | 프로세스 변종 + 역할 | 프로세스 맵 |
| E. UI 배포 | 1주 | 사람 중심 Workshop 뷰 | `/admin/people/{id}` |

## 환경변수 (.env)

```
# nenova-erp-ui (Layer 1 — Phase A)
NENOVA_ERP_URL=https://nenova-erp-production.up.railway.app
NENOVA_ERP_USER=<관리자_ID>
NENOVA_ERP_PASS=<관리자_PASS>
NENOVA_ERP_POLL_INTERVAL_MS=60000

# 기존 mindmap-viewer DATABASE_URL 재사용
```

## 보안 원칙
- ERP 접근은 read-only로 한정 (POST/PATCH/DELETE 호출 없음)
- 자격증명은 `.env`만, git 커밋 금지
- 카톡 원문은 `_agent_intelligence`에 이미 분석된 형태(`extracted_fields`, `alerts`)만 끌어옴 (개인정보 최소화)
