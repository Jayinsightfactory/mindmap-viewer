# TOTAL_PLATFORM.md — 토탈 플랫폼 로드맵 (골모드 `골:`)

> 비전: **Orbit(업무 모니터링·학습) + nenovaweb/nenova.exe(ERP·주문) + 실전업무(카톡/시트)** 를 합친 **회사 OS**.
> 골모드(`골:`)로 작업할 때 이 로드맵 기준으로 사고·구현. (2026-06-18 작성)

---

## 현재 보유 자산
- **Orbit 수집**(✅): 키보드 내용(한글변환), 화면 Vision, 마우스 좌표, 앱·시간 — `DAEMON_STRUCTURE.md`
- **nenovaweb**: ERP/주문/배송/거래처 + **n8n 자동화 브리지 `/api/automation/*`** (메모리 [[nenovaweb-n8n-automation]])
- **nenova.exe**: 데스크톱 ERP (메모리 [[order-matching-architecture]] 등)
- **소통**: 카톡/구글시트 (메모리 [[nenovakakao-workflow-integration]])
- **대시보드**: `/admin-analysis.html`, `/work-logs.html`

## 회사 OS 5레이어 (팔란티어식)
```
L1 수집      ✅ Orbit (키/화면/마우스) + ERP 상태
L2 분석      🔄 세션분류·자동화점수·교차검증  ← 현재 핵심
L3 자동화엔진 ⬜ PAD/pyautogui/AHK 스크립트 자동생성
L4 대시보드   ✅ 관리자/업무로그 (의미화 강화 필요)
L5 의사결정   ⬜ 인력배치·병목예측·프로세스설계
```

---

## Phase 1 — 데이터 의미화 (Orbit raw → 업무 인사이트)
**목표**: raw 이벤트를 "누가·어디서·무엇을·얼마나" 업무단위로.
- 세션 분류: keyboard.chunk(내용) + screen.analyzed(Vision) + mouse → 업무 세션 (예: "nenova 주문관리에서 주문번호·수량 입력, 하루 12회·건당 8분, 반복클릭 (x,y)")
- 자동화 점수: 반복패턴·복붙·고정좌표 → 후보 랭킹
- 산출: ①직원/팀 업무 리포트 ②자동화 후보 리스트 ③병목·이상 알림
- 활용: `nenova-data-fusion`(병합) → `nenova-workflow-forecaster`(예측)

## Phase 2 — nenovaweb 연동 (양방향)
**목표**: Orbit 인사이트 ↔ ERP 실데이터 결합.
- Orbit→web: 자동화 후보를 **n8n 브리지(`/api/automation/*`)** 통해 nenovaweb 액션으로 (주문입력 자동화·매칭개선)
- web→Orbit: ERP 상태(주문/배송/거래처) + Orbit 실제행동 **교차검증** ("직원이 입력했다 vs ERP 반영됐다 vs 카톡 요청과 일치")
- 활용: `nenova-cross-validator` (카톡/클릭/ERP 3차 교차)

## Phase 3 — 토탈 플랫폼 (통합 화면·자동화·의사결정)
**목표**: 한 화면에서 주문·업무행동·소통·자동화.
- 통합 뷰: 주문(ERP) + 업무행동(Orbit) + 카톡소통 + 자동화 실행/상태
- 자동화 엔진(L3): 검증된 후보 → PAD/pyautogui 스크립트 자동생성·테스트·배포
- 의사결정(L5): 인력배치·이슈예측·프로세스 재설계 — `nenova-ops-orchestrator`(PASS/WARN/FAIL+다음액션)

---

## 다음 한 수 (제안)
1. **Phase 1 의미화 엔진**부터 — 지금 들어오는 키보드 내용·Vision·마우스를 "업무 세션 + 자동화 후보"로 만드는 서버 분석(work-learner 강화).
2. 그 산출을 **work-logs/admin-analysis에 "업무 단위·자동화 후보"로 표시**.
3. 검증된 후보 1개를 **n8n 브리지로 nenovaweb 자동화** 실증 → Phase 2 진입.

> 우선순위·범위는 `골:` 지시 시 확정. 데몬 변경은 `DAEMON_STRUCTURE.md`, ERP는 nenovaweb 메모리 먼저 읽고 시작.
