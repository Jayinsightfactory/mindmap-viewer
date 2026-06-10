# SOLUTION_LINK — mindmap-viewer / Orbit (네노바 통합 솔루션의 시각화·지능 계층)

> 마스터 문서: `C:\Users\USER\NENOVA_SOLUTION_AUDIT.md`
> 이 repo의 상세 작업 지침: `ORBIT_3D_REDESIGN_GUIDE.md` (옵시디언×3D 재설계)
> Cursor 작업 시 이 파일 + 위 두 문서를 컨텍스트에 포함할 것.

## 이 repo의 역할
Orbit = AI 작업 추적(데몬 수집) + 3D 그래프 시각화 + 인사이트 엔진 (완성도: 서버/3D ~60%, 데몬 ~68%).
**솔루션 내 위치: 모든 구성요소의 활동을 "보는 눈" + 향후 통합 모니터링/회사OS.**

## 연결 지점

| 상대 | 방향 | 인터페이스 | 상태 |
|---|---|---|---|
| orbit 데몬 (`daemon/`, `~/.orbit`) | IN | `POST /api/hook` (키보드/화면/파일/클립보드 이벤트) | ✅ |
| Google Drive | OUT | 캡처 백업 (drive-uploader) | ❌ 403 — 서비스계정 quota, Shared Drive 전환 필요 |
| Claude Vision | 내부 | bin/vision-worker.js 캡처 분석 (Phase 4) | 🔄 진행 중 |
| nenova-erp-ui | IN(계획) | ERP 지표 수집 → nenova-dashboard.html | ⚠️ 일부 |
| recorder / agent-bridge | OUT(계획) | 자동화 스크립트 실행 계층 (Phase 5) | ❌ 코드만, 미연결 |
| talkhub | OUT(계획) | 인사이트/병목 감지 → talkhub 봇 알림 | ❌ 기획만 |

## 이 repo에서 작업할 때의 목적 (우선순위)
1. **P1: 데몬 안정화 (Track A = 100% 수집 유지)** — Drive 인증 수정(Shared Drive 전환), file-learner 감시제외에 Codex/Unity 빌드 폴더 추가(EBUSY 크래시 37건/5분), 설치 신뢰도(pass=7 fail=4) 개선. 중소기업 트랙은 원본 포함 풀 수집이 기본 — 데이터 자산 극대화 (`ORBIT_PLATFORM_PLAN.md` §2-1 투트랙).
2. **P1.5: 수집 프로파일 구조** — `collection_profile: full | local_first` 설정 도입 (모듈 on/off·보관기한·전송 스키마 화이트리스트·직원 셀프 대시보드). Track B(중견·대기업)는 이 프로파일 전환만으로 대응.
3. **P1: 옵시디언×3D 재설계** — `ORBIT_3D_REDESIGN_GUIDE.md`의 Phase A부터. 기존 orbit.html 건드리지 말고 신규 파일 병행.
4. **P2: 통합 모니터링 1페이지** — 데몬 heartbeat + ERP `/api/ecount/status` + n8n ping + kakao 파이프라인 상태를 한 화면에 (솔루션 누락 ⑧의 해결처가 이 repo).
5. **P3: 컨텍스트 엔진화** — 이벤트 그래프/패턴/매칭 자산을 MCP 서버로 노출해 에이전트가 질의하게. 3D 그래프 = 에이전트 감독 관제탑.
   ※ **구 Phase 5(PAD/pyautogui 스크립트 자동 생성)는 폐기** — 컴퓨터 사용 에이전트가 대체. recorder/agent-bridge 실행 계층도 보류 (마스터 문서 §4).

## 데모 자산 (이 repo)
- `public/demo/solution.html` — ORBIT 솔루션 데모 (영업 시연 메인)
- `public/demo/pilot-checklist.html` — PoC 4주 체크리스트
- 네이밍: 이 repo = **Orbit Map**(웹) + **Orbit Agent**(daemon) + **Orbit Flow**(엔진). UI 노출 텍스트는 이 모듈명 사용.

## 작업 규칙
- `server.js`는 416KB — 새 엔드포인트는 반드시 `routes/`에 모듈로.
- `/api/graph` 응답 하위호환 유지 (orbit3d.html 등 기존 소비자 존재).
- `nenova-erp-ui/` 목업 하위폴더는 **2026-06-10 삭제됨** — 운영 ERP는 `C:\Users\USER\nenova-erp-ui` 별도 repo. 이 repo 안에 ERP UI를 다시 만들지 말 것.
- 키로거/캡처 관련 기능 추가 시 직원 동의·마스킹 정책(마스터 문서 누락 ⑥) 고려.
