# 사실(facts) — CLAUDE.md에서 분리한 구조·경로·스택·환경 설명
> 왜 분리했나: CLAUDE.md는 항상 지킬 원칙만 두고, 바뀌는 사실 정보는 여기로 옮겼다(원문 그대로, 삭제 없음).
> 언제 읽나: 프로젝트 경로·스택·URL·UI 구조·파이프라인·기능 목록이 필요할 때. 낡았을 수 있으니 코드로 재확인.

## 프로젝트 정보

| 항목 | 값 |
|------|-----|
| 경로 (원본) | Google Drive `내 드라이브/mindmap-viewer/` |
| 경로 (git) | `/Users/darlene/mindmap-viewer/` |
| 서버 | Node.js Express |
| 프론트 | 바닐라 JS + Three.js 3D |
| DB (프로덕션) | PostgreSQL (`src/db-pg.js`) |
| 프로덕션 URL | https://mindmap-viewer-production-adb2.up.railway.app |
| 관리자 대시보드 | `/admin-analysis.html` |
| Railway | `mindmap-viewer` (tranquil-analysis 프로젝트), 힙 768MB |
| Google Cloud | dlaww584@gmail.com, 프로젝트 orbit-ai-490604 |

---

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
    ↓ [병렬 경로 — Railway 서버사이드]
src/server-vision-worker.js (2026-04-27 추가)
├── screen.capture 수신 즉시 global._visionImageQueue 적재
├── 8초 인터벌로 큐 처리 → Anthropic API (ANTHROPIC_API_KEY 필요)
└── screen.analyzed 이벤트 저장
⚠️ 두 경로 중복 없음: Drive 경로는 파일 기반, 서버 경로는 메모리 큐 기반
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
## Google Drive 기획 폴더

`내 드라이브/Orbit AI 기획/`
- 01_자동화_기획서.md
- 02_에이전트팀_실행_가이드.md
- 03_기획회의_2026-03-17.md
- 04_회사OS_정밀분석_기획.md

---
## 테스트 계정
- **관리자**: 임재용 / dlaww584@gmail.com / orbit2024 / ID: MMONWUCHC96FB6029B
- **테스트**: jaeyong lim / dlaww584@gmail.com / orbit2024 / ID: MMOMY4OB91D6574436
