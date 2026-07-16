# 편의성 통폐합 계획 — 60 페이지 → 통합 셸 1 + 뷰 8

> 작성 2026-07-16. 실측(제목·참조수·수정일) 기반. 목업: scratchpad/orbit-consolidation.html
> 목표: "오너·직원·팀장·타사가 하나의 시각화로" = 페이지를 늘리지 말고 **없애서** 도달.
> ORBIT_3D_REDESIGN_GUIDE.md(2026-06, "15개+ 페이지 따로 논다")의 후속 — 그때보다 60개로 늘어 방치됨.

## 실측 근거

- 사용자 대면 페이지 **60개**, server.js 라우트 **299개**, orbit3d 패널 토글 16개, 허브(viewer)는 4개만 링크.
- 대부분 **2026-06-29 대량 자동생성분**(개별 재작성 비용 낮음). ref=0 고아 다수.
- 중복: 대시보드 **10개**, 그래프/맵 **13개** — 23개가 사실상 2가지 일의 변주.

## 목표: 통합 셸 1 + 뷰 8 (역할=페이지 아님, 스코프 전환)

| # | 뷰 | 주력 페이지(유지) | 흡수 |
|---|---|---|---|
| 1 | 홈·내 워크스페이스(자기구성) | app.html | dashboard, orbit-os, orbit-hub, conversation-dashboard |
| 2 | 그래프·맵(상태그래프+줌+타임라인) | orbit3d.html | graph, orbit-timeline, mindmap, project-map, org-hierarchy |
| 3 | 현황·분석(내/팀/전사/타사 스코프) | admin-analysis.html | analysis, team-dashboard, team-command, nenova-dashboard(모바일), consultant, contributor-dashboard, admin-analytics, work-logs, history, issues |
| 4 | 자동화·솔루션 | automation-flow.html | process-mining, automation, automation-visual |
| 5 | 커뮤니케이션(원인 소스) | chat.html | kakao-intel, community, chat-history |
| 6 | 마켓 | solution-market.html | marketplace, theme-market |
| 7 | 설정·계정 | settings.html | admin-workspace, invite, pricing, privacy, terms |
| 8 | 온보딩·도움말(셸 밖) | setup.html | guide, install-guide, chrome-guide, index, viewer, select |

- **랜딩 예외**: moyi.html(마케팅, ref0) = 비로그인 랜딩 별도 유지.

## 은퇴/병합 11개 (삭제 전 301 리다이렉트)

mockup-chat, mockup-mobile-home, mockup-select, workspace-drilldown-demo, legacy-2d, workflow-blueprint(ref0), automation-blueprint(ref0), admin-intelligence-golden(ref0), orbit-live(ref0), orbit.html(orbit3d 구판), orbit-health(ref0).

**⚠ 별도 결정**: cctv.html("업무 CCTV") — 이름·성격이 프라이버시 설계(본인 승인·공개통제)와 충돌. "감시"→"본인 동의 관찰"로 재정의 or 제거.

## 라우트·URL 정리

- `/orbit3d.html`·`/dashboard.html`·… → 셸 `/app` + 뷰 해시(`/app#graph`, `/app#status?scope=team`).
- 은퇴 11개 URL → **301** 대응 뷰로(죽은 링크 0).
- index(0KB)·viewer(4링크) → 셸 진입점(역할 감지 후 기본 뷰).
- 모바일 nenova-dashboard 별도 셸 → 같은 셸 반응형(한 앱).
- server.js 299 라우트: 페이지 서빙은 셸 1개로, API는 routes/ 모듈 유지(기존 방침, ORBIT_3D_REDESIGN §7).

## 순서 주의 — 두 관문은 병렬

1. **구조(이 문서)**: 60→8 셸 통합 = 도달성·편의성. UI 레이어.
2. **품질(별개)**: 자동구성 정확도(거래처키 2.1%·검증사슬 0·분석 0.8%)가 차야 뷰가 실제 유용. solution-miner 크리틱 루프가 상시 측정 중.
- 셸만 예쁘면 빈 그릇, 데이터만 좋으면 60페이지에 흩어져 못 씀. 둘 다 필요.

## 구현 단계 제안(작게, Phase별 `node server.js` 확인)

- **A. 셸 골격**: 통합 셸 1개(상단바=신원·스코프·공개설정·검색 + 좌측 뷰 8) 신규. 기존 페이지 건드리지 않고 병행.
- **B. 뷰 이식**: 주력 8개를 셸 안 뷰로 이관(iframe/컴포넌트), 나머지 흡수.
- **C. 은퇴+리다이렉트**: 11개 301, 모바일 반응형 통합.
- **D. 전환**: `/`를 셸로, 구 페이지 `/legacy/*`.

관련: [[ORBIT_3D_REDESIGN_GUIDE.md]], scratchpad 목업 3종(nenova-ops-home, orbit-self-web, orbit-consolidation).
