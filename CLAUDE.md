# Orbit AI — 내 웹 서비스 프로젝트

> **이것은 내가 기획하고 만드는 웹 서비스다.**
> 모든 답변과 작업은 이 웹 서비스 기획/개발 관점에서 이루어져야 한다.
> 일반적인 코딩 도움이 아니라, **제품 공동 기획자**로서 행동한다.

---

## 절대 규칙

### 0. 반복 감지 진단 프로토콜 (최우선)
**사용자가 이전에 했던 지시와 겹치는 요청을 하면, 절대로 바로 다시 구현하지 않는다.**

대신 다음 진단 프로세스를 따른다:

```
Step 1: 커밋 확인 → git log --oneline -20
Step 2: 코드 존재 확인 → grep/read
Step 3: 왜 안 되는지 원인 진단 (A: 미배포 / B: 연결 누락 / C: 버그)
Step 4: 최소 수정 → 전체 재작성 금지
Step 5: 메모리 업데이트
```

### 1. 에이전트 팀 필수
- 모든 작업에 **에이전트 병렬 실행** 활용
- 같은 파일 동시 수정 금지
- 완료 후 rsync → git diff → 충돌 없으면 commit

### 2. 기존 코드 충돌 금지
- 기존에 만들어놓은 기능과 **절대 충돌 안 됨**
- 수정이 필요하면 기존 코드를 **편집** (새로 작성 X)
- HTML 인라인 코드와 JS 파일 중복 주의 (이전 버그 원인)

### 3. 프로덕션 우선
- `src/db.js` 수정 시 반드시 `src/db-pg.js`도 동기화
- PG 테이블명: `orbit_auth_users` (NOT `users`)
- 배포: GitHub main push → Railway 자동배포

---

## 프로젝트 정보

| 항목 | 값 |
|------|-----|
| 경로 (원본) | Google Drive `내 드라이브/mindmap-viewer/` |
| 경로 (git) | `/Users/darlene/mindmap-viewer/` |
| 서버 | Node.js Express |
| 프론트 | 바닐라 JS + Three.js 3D |
| DB (프로덕션) | PostgreSQL (`src/db-pg.js`) |
| 프로덕션 URL | https://sparkling-determination-production-c88b.up.railway.app |
| 관리자 대시보드 | `/admin-analysis.html` |
| Railway | `sparkling-determination`, 힙 768MB |
| Google Cloud | dlaww584@gmail.com, 프로젝트 orbit-ai-490604 |

---

## 제품 철학 (절대 원칙)

### 워크스페이스 = 회사
- 워크스페이스 안에서 팀 배분
- "팀뷰" 용어 사용 금지 → **"워크스페이스"**

### 데이터 격리
- 각 계정은 자기 데이터만 본다. 다른 사람 데이터 절대 노출 금지.
- 개인 화면에 팀원/팔로워 구체 표시 안 함 (본인만)

### 정밀 분석 (통계 아님)
- ❌ "nenova 155회 사용" → 쓸모없는 통계
- ✅ "nenova 신규 주문 관리 화면에서 주문번호/수량/고객명 입력 → 저장, 하루 12회, 건당 8분"
- 캡처 이미지 Vision 분석 → 어떤 화면, 어떤 버튼, 어떤 데이터
- 마우스 좌표 → UI 동선, 반복 클릭 좌표 → 자동화 지점

### 3중 데이터 파이프라인
1. **스크린 캡처 + Claude Vision** → "뭘 하고 있는지" (WHAT) — 핵심
2. **키로거** → "뭘 입력하는지" (INPUT)
3. **마우스 좌표** → "어디를 누르는지" (WHERE)

### 자동화 방향
- 통계 → 정밀 분석 → 자동화 스크립트 생성 → 테스트 → 배포
- 도구: PAD(UI셀렉터), pyautogui(좌표), AutoHotkey(매크로), PowerShell(COM)
- nenova는 데스크톱 앱 → PAD 먼저, 안 되면 pyautogui+Vision

### 관점별 가치
| 관점 | 보는 것 |
|------|---------|
| **개인** | 내 업무/생활 패턴, 시간 배분 |
| **관리자** | 직원 업무 현황, 팀간 협업, 자동화 기회 |
| **사장/임원** | 전사 프로세스, 부서간 흐름, 병목 |
| **플랫폼 관리자** | 부분 자동화, 이슈 트리거, 점진적 개선 |

### 회사 OS (팔란티어식)
```
Layer 1: 데이터 수집 ✅
Layer 2: 정밀 분석 (Vision + 키로거 + 마우스) — 진행 중
Layer 3: 자동화 엔진 (PAD/pyautogui/AHK 스크립트 자동 생성)
Layer 4: 관리자 대시보드 ✅ (/admin-analysis.html)
Layer 5: 의사결정 지원 (인력 배치, 이슈 예측, 프로세스 설계)
```

---

## 3D UI 구조 (워크스페이스 뷰)

### 태양계 방식
```
◉ 회사 중심 (워크스페이스 코어)
│
├── 큰 궤도 (원형) — 팀 클러스터가 공전
│
│   ╭── Team 1 ──╮     ╭── Team 2 ──╮
│   │ ○멤버 ○멤버 │     │ ○멤버 ○멤버 │  ← 멤버들이 모여서 팀 덩어리
│   │  ├세션 ├세션 │     │  └세션      │  ← 프로젝트 세션은 멤버 주위 위성
│   ╰────────────╯     ╰────────────╯
│
│   cooperation (팀간 협업선 — 있을 때만)
│
╰── 큰 궤도
```

### 규칙
- **팀 중심 구체 = 없음** (멤버만 모여서 팀 형성, 팀명은 텍스트만)
- **궤도선**: 회사 궤도 1개 + 팀별 클러스터 궤도
- **연결선**: 협업(cooperation) 있을 때만. 없으면 선 없음
- **기본 간격**: 150%
- **개인 화면**: 본인 데이터만 (팀원 구체 안 보임)

---

## 데이터 파이프라인

```
사용자 PC (데몬: daemon/personal-agent.js)
├── keyboard-watcher.js: 키 입력, 앱, 윈도우타이틀, 마우스
├── screen-capture.js: 이벤트 기반 캡처 → ~/.orbit/captures/
├── drive-uploader.js: 캡처 → Google Drive (5분마다)
├── daemon-updater.js: 자동 업데이트 (평일 09:30/13:00/15:00)
└── → 서버 /api/hook 으로 이벤트 전송
    ↓
서버 (Railway)
├── work-learner.js: 학습 엔진 (세션감지/분류/패턴/자동화점수)
├── report-sheet.js: Google Sheets 리포트 (09:00/13:30/18:00 KST)
├── graph-engine.js: 그래프 빌드 (NOISE_TYPES 필터)
└── /admin-analysis.html: 관리자 대시보드
    ↓
관리자 맥 (Vision 워커: bin/vision-worker.js)
├── Google Drive 캡처 → Claude Vision (CLI 모드, API 키 불필요)
└── 분석 결과 → 서버 DB (screen.analyzed)
```

### 노이즈 필터 (그래프에 안 보임)
`install.progress`, `daemon.update`, `daemon.error`, `screen.capture`

---

## 완료된 기능

### 백엔드 API

| 기능 | 라우트 | 상태 |
|------|--------|------|
| 인증 (Google OAuth) | `src/auth.js`, `src/auth-oauth.js` | ✅ |
| 3D 그래프 | `routes/graph.js` | ✅ |
| 이벤트 수신 (데몬→서버) | `server.js /api/hook` | ✅ |
| 워크스페이스 | `routes/workspace.js` | ✅ |
| DM/채팅 | `routes/chat.js` | ✅ |
| 팔로우 | `routes/follow.js` | ✅ |
| 프로필 | `routes/profile.js` | ✅ |
| 학습 분석 | `server.js /api/learning/*` | ✅ |
| 정밀 분석 | `server.js /api/learning/deep-analyze` | ✅ |
| 로그 조회 | `server.js /api/learning/logs` | ✅ |
| Sheets 리포트 | `server.js /api/learning/report` | ✅ |
| 데몬 업데이트 | `server.js /api/daemon/*` | ✅ |
| Drive 설정 | `server.js /api/daemon/drive-config` | ✅ |

### 데몬 모듈

| 모듈 | 파일 | 상태 |
|------|------|------|
| 키보드 와처 | `src/keyboard-watcher.js` | ✅ |
| 스크린 캡처 | `src/screen-capture.js` | ✅ |
| Drive 업로더 | `src/drive-uploader.js` | ✅ |
| 자동 업데이터 | `src/daemon-updater.js` | ✅ |
| 워크플로우 학습 | `src/workflow-learner.js` | ✅ |
| 도구 프로파일러 | `src/tool-profiler.js` | ✅ |
| Vision 워커 | `bin/vision-worker.js` | ✅ |

### 프론트엔드

| 컴포넌트 | 상태 |
|---------|------|
| 3D 우주 뷰 (Three.js 와이어프레임 구) | ✅ |
| 워크스페이스 뷰 (태양계 방식) | ✅ |
| 관리자 대시보드 (/admin-analysis.html) | ✅ |
| 워크스페이스 카드 (선택 후 관리버튼 확장) | ✅ |
| 인원배분 모달 (팀 추가/수정/삭제 + 저장) | ✅ |
| 설치코드 복사 (사용자 토큰 포함) | ✅ |

### 인프라

| 항목 | 상태 |
|------|------|
| Google Cloud 서비스 계정 | ✅ |
| Google Drive 캡처 폴더 | ✅ |
| Google Sheets API | ✅ |
| Railway 자동 배포 | ✅ |
| 데몬 자동 업데이트 (평일 3회) | ✅ |
| 설치 스크립트 (Windows) | ✅ |
| AhnLab V3 예외 등록 | ✅ |

---

## 워크스페이스 현황

**nenova** (네노바, 6명)

| 멤버 | 팀 | PC | 데몬 | 주요 앱 |
|------|-----|-----|------|---------|
| 임재용 (owner) | 영업지원 | 이재만 | 구버전 | chrome |
| 설연주 | 영업지원 | NEONVA | 구버전 | **nenova** |
| 강현우 | 영업지원 | DESKTOP-T09911T | 구버전 | explorer |
| 박성수 | 영업팀 | DESKTOP-HGNEA1S | 구버전 | kakaotalk |
| ㅋㅋ(현욱) | 영업팀 | DESKTOP-CAA5TA1 | **최신** | kakaotalk |
| jaeyong lim | 팀 미배정 | - | - | - |

**긴급**: 4대 수동 설치코드 재실행 필요 (1회만, 이후 자동)

---

## 비전 로드맵

```
Phase 1 ✅ 개인 작업 추적 + 3D 시각화
Phase 2 ✅ 데이터 수집 파이프라인 (키로거/캡처/Drive)
Phase 3 ✅ 학습 엔진 + 관리자 대시보드
Phase 4 🔄 Vision 정밀 분석 (캡처→화면해독→자동화지점 특정) ← 현재
Phase 5 ⬜ 자동화 스크립트 자동 생성 + 테스트 배포
Phase 6 ⬜ 회사 OS (실시간 대시보드/KPI/병목감지/의사결정)
```

---

## Google Drive 기획 폴더

`내 드라이브/Orbit AI 기획/`
- 01_자동화_기획서.md
- 02_에이전트팀_실행_가이드.md
- 03_기획회의_2026-03-17.md
- 04_회사OS_정밀분석_기획.md

---

## 작업 원칙

### 시지푸스 모드
작업이 완전히 끝날 때까지 멈추지 않는다. 오류가 있으면 스스로 수정한다.

### 프로메테우스 계획
큰 작업은 바로 시작하지 않는다. 핵심 질문으로 의도 파악 → 계획 → 승인 후 시작.

### 울트라 워크 (`ulw:`)
`ulw:` 로 시작하면 최고 성능 — 병렬 에이전트, 완전 구현, 검증까지.

### 오라클 모드 (`fix:`)
`fix:` 로 시작하면 근본 원인 분석 + 비정통적 방법도 시도.

---

## 커뮤니케이션
- 한국어 사용
- 간결한 답변, 결과 위주
- 단계별 설명보다 실행 우선

## 테스트 계정
- **관리자**: 임재용 / dlaww584@gmail.com / orbit2024 / ID: MMONWUCHC96FB6029B
- **테스트**: jaeyong lim / dlaww584@gmail.com / orbit2024 / ID: MMOMY4OB91D6574436
