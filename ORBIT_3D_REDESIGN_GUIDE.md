# Orbit 웹사이트 재설계 — 옵시디언 그래프 뷰 × 3D (Cursor 작업 지침)

> 작성: 2026-06-10. 이 문서는 Cursor에게 그대로 컨텍스트로 주는 작업 지침이다.
> 함께 참조할 파일: `CLAUDE.md`, `public/js/orbit-app.js`, `public/orbit.html`, `routes/graph.js`, `src/graph-engine.js`

---

## 1. 현재 구조의 문제 (왜 재설계하나)

- 페이지 15개+(orbit, orbit3d, dashboard, chat, issues, process-mining, marketplace…)가 **각각 독립된 HTML**로 따로 논다. 그래프는 그중 한 페이지일 뿐이다.
- 3D 그래프(`orbit-app.js`, 2000+줄)는 **InstancedMesh + 수동 좌표 배치 + 공전 애니메이션**을 직접 구현 — 레이아웃이 계층 고정이라 옵시디언처럼 "연결 구조가 보이는" 그래프가 아니다.
- 노드 600개 상한, 엣지는 부모-자식만. 양방향/교차 링크 표현 불가.

## 2. 목표 구조: "그래프가 곧 네비게이션" (옵시디언 모델)

옵시디언의 본질 = **그래프가 홈이고, 노드를 클릭하면 그 안의 내용이 열린다.** 이를 3D로:

```
┌────────────────────────────────────────────────────────┐
│  상단바: 검색(Ctrl+K) · 모드전환(3D/2D) · 시간범위        │
├──────┬───────────────────────────────────┬─────────────┤
│ 좌측  │                                   │  우측 패널    │
│ 도구바│        3D Force Graph (풀스크린)    │  (노드 클릭시) │
│      │                                   │             │
│ ·필터 │   Global ↔ Local ↔ Timeline 모드   │  ·디테일      │
│ ·그룹 │                                   │  ·대시보드 탭  │
│ ·레이어│                                   │  ·채팅 탭     │
├──────┴───────────────────────────────────┴─────────────┤
│  하단: 타임라인 스크러버 (시간대별 그래프 재생)              │
└────────────────────────────────────────────────────────┘
```

### 그래프 3모드
1. **Global**: 전체 워크스페이스 그래프 (옵시디언 전역 그래프). 노드크기=연결수(degree), 타입별 색.
2. **Local**: 노드 더블클릭 → 그 노드 중심 depth 1~3 이웃만 (옵시디언 로컬 그래프). 뒤로가기 스택 유지.
3. **Timeline**: 시간축으로 노드가 생겨나는 재생 모드 (Orbit 고유 강점 — 작업 흐름 추적).

### 옵시디언에서 차용할 기능 체크리스트
- [ ] hover 시 이웃 노드/엣지 하이라이트 + 나머지 dim
- [ ] 검색어 입력 시 매칭 노드만 발광, 카메라 자동 포커스
- [ ] 색상 그룹: `type:session → 파랑` 같은 규칙 UI (기존 `user_categories` 테이블 재활용)
- [ ] 고아 노드(연결 0) 표시 토글
- [ ] 필터: 이벤트 타입 / 기간 / 사용자 / 프로젝트
- [ ] 노드 클릭 → 우측 패널에 상세(세션이면 이벤트 목록, 파일이면 접근 이력)

## 3. 기술 스택 결정

**`3d-force-graph` (vasturiano) 도입을 권장** — three.js + d3-force-3d 래퍼. 옵시디언식 3D 그래프의 사실상 표준 라이브러리.
- 자체 구현 InstancedMesh/공전 로직을 대체. force-directed 레이아웃, 노드 클릭/호버, 링크 파티클, 카메라 포커스 내장.
- 2D 토글은 같은 제작자의 `force-graph`(canvas)로 — 옵시디언 기본 뷰 느낌.
- 라벨은 `three-spritetext` 또는 기존 CSS2DRenderer 유지.
- 수천 노드까지 처리 가능 → 기존 600개 상한 해제. 5천+ 시 클러스터링(세션 단위 묶음)으로 LOD.

## 4. API/데이터 변경 (백엔드)

`routes/graph.js`의 `/api/graph` 수정:
- **좌표(x,y,z) 사전계산 제거** — force 레이아웃이 클라이언트에서 계산. (단, 기존 `orbit3d.html`이 같은 API를 쓰면 하위호환 위해 `?layout=force` 쿼리로 분기)
- 노드에 `degree`(연결수), `group`(타입/카테고리) 필드 추가.
- 신규: `GET /api/graph?focus=<nodeId>&depth=<n>` — 로컬 그래프용.
- 신규: `GET /api/graph?from=<ts>&to=<ts>` — 타임라인용.
- `src/graph-engine.js`의 `buildGraph()`에서 부모-자식 외에 **교차 엣지** 생성: 같은 파일을 만진 세션끼리, 같은 에러를 공유한 이벤트끼리 연결 (이게 옵시디언식 "양방향 링크"의 Orbit 버전).

## 5. 기존 페이지 흡수 계획

| 기존 페이지 | 새 구조에서 |
|---|---|
| orbit.html / orbit3d.html | → 새 그래프 셸로 통합 (메인 `/`) |
| dashboard.html | → 우측 패널 "대시보드" 탭 (개인 노드 클릭 시) |
| chat.html | → 도킹 패널 (그래프 위 오버레이) |
| issues.html, process-mining.html | → 그래프 "레이어" 모드 (자동화 이슈를 그래프에 오버레이) |
| admin-*, team-dashboard | → 조직 노드 클릭 시 패널, 또는 별도 라우트 유지 |
| marketplace, settings, privacy/terms | → 별도 라우트 유지 |

## 6. 구현 단계 (이 순서대로)

- **Phase A — 그래프 엔진 교체**: `public/graph.html` + `public/js/graph-shell.js` **신규 생성** (기존 orbit.html은 건드리지 말 것). 3d-force-graph로 `/api/graph` 렌더 + Global/Local 모드 + 검색/하이라이트.
- **Phase B — 패널 흡수**: 우측 패널에 dashboard/디테일 탭, 노드 타입별 상세 API 연결.
- **Phase C — 타임라인/필터/색상그룹**: 하단 스크러버, 필터 UI, `user_categories` 연동.
- **Phase D — 교체 & 성능**: 검증 후 `/` 라우트를 graph.html로 전환, 구 orbit.html은 `/legacy`로. 노드 5천+ 클러스터링.

## 7. Cursor 작업 규칙 (중요)

1. **기존 orbit.html / orbit-app.js를 수정하지 말고** 새 파일(graph.html, graph-shell.js)로 병행 개발 → 검증 후 교체.
2. `server.js`는 416KB 거대 파일 — **새 엔드포인트는 반드시 `routes/` 폴더에** 모듈로 추가.
3. `/api/graph` 응답 포맷은 하위호환 유지 (orbit3d.html 등 기존 소비자 존재). 변경은 쿼리 파라미터로 opt-in.
4. 라이브러리는 importmap ESM 방식 유지 (`public/orbit.html:9-16` 패턴 참고).
5. 이벤트 노이즈 필터(`graph-engine.js`의 NOISE_TYPES) 유지 — `daemon.*`, `screen.capture`는 그래프에서 제외.
6. 커밋 단위: Phase별로 작게. 각 Phase 끝에 `node server.js` 띄워서 브라우저 확인.
