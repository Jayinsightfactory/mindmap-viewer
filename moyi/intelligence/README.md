# Part B — 지능 · 시각화 (Intelligence / Viz)

> "배우다·보이다". 온톨로지·흐름·에이전트가 여기 모인다. **파일은 제자리, 이 인덱스가 경로로 가리킴.**

## 1. 온톨로지 엔진
| 파일 | 역할 |
|---|---|
| `routes/ops-ontology.js` | `promote()` events→Action(`unified_events` work.action)+`ops_relation` 승격, 30분 cron. stats/entities/relations/actions·context API **(테넌트 격리 ✓)** |
| `src/flow-handoff.js` | 핸드오프 엔진 — `action_handoff`(사람간 인계)·`action_mentions_customer`·`action_updated_erp` |
| `src/intelligence/entity-resolution/*` | 거래처 매칭(korean-normalizer·bootstrap-customer·match-customer-fuzzy·scheduler) |
| 테이블 | `unified_events` · `ops_relation` · `orbit_entity_golden`(person/customer, workspace_id) |

## 2. 흐름 API
| 파일 | 역할 |
|---|---|
| `routes/flow-map.js` | `/api/flow/{company,employee,workunit,people,ops-input,ops-report}` **(전 쿼리 테넌트 격리 ✓)** |
| (재사용) `src/company-ontology-pg.js` | 회사 그래프 스켈레톤 |

## 3. 옵시디언 그래프 뷰
| 파일 | 역할 |
|---|---|
| `public/graph.html` | 다크 캔버스 셸 + 줌 3단 + 운영 인사이트 패널 + 1시간 자동새로고침 |
| `public/js/graph-shell.js` | 3d-force-graph(3D)/force-graph(2D), 노드클릭→OAG 증거패킷, 신뢰도 고리 |
| 지침 | `ORBIT_3D_REDESIGN_GUIDE.md`(옵시디언×3D) |

## 4. 에이전트 파이프라인
| 파일 | 역할 |
|---|---|
| `.claude/agents/nenova-{data-fusion,workflow-forecaster,cross-validator,ops-orchestrator}.md` | 온디맨드 서브에이전트(병합→예측→검증→조율) |
| `bin/ops-agent-worker.js` | owner PC Claude CLI(무과금) 4h 주기 → 예측·병목·검증·자동화·disagreement → `/api/flow/ops-report` |
| `src/insight-engine.js` | 24h 인사이트(규칙+Haiku) |

## 관련 메모리
- 흐름 청사진·핸드오프·테넌트 격리(T0a): memory `flow-blueprint-obsidian-graph`
- 실시간 Haiku 비용 차단: memory `api-cost-ollama-analyzer-haiku`
- 온톨로지·매칭 구조: memory `order-matching-architecture`
