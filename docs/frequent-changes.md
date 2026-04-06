# Orbit AI — 자주 수정되는 영역 & 연관관계

> 수정 시 반드시 같이 바꿔야 하는 파일 목록. 이걸 빠트리면 버그 발생.

---

## 1. 설치 방식 변경 (install.ps1)

**수정 파일**: `setup/install.ps1`

**같이 바꿔야 하는 것:**
- `public/js/orbit3d-data-load.js` — `_showInstallCodeModal()` / `_showEmptyStateGuide()` 안에 설치 명령 문구
- `src/daemon-updater.js` — Step 6 Startup 등록 로직 (install.ps1과 동일한 방식 유지)

**왜 반복됐나:**
- EXE → PS1 → 인코딩 수정 × 3회
- 매번 install.ps1만 바꾸고 orbit3d-data-load.js 누락 → UI에 구버전 명령 표시

**현재 상태 (2026-04-06 기준):**
- install.ps1 Step 6: Task Scheduler(primary) + Startup VBS(fallback) ✅
- daemon-updater.js: Task Scheduler 갱신 + VBS fallback ✅

---

## 2. 데몬 부팅 자동시작 방식

**문제**: VBS → PS1 체인이 끊어지면 재부팅 후 데몬 안 뜸

**원인 3가지:**
| 원인 | 증상 |
|------|------|
| PowerShell ExecutionPolicy 변경 | VBS 실행은 되는데 PS1 차단 |
| VBS 파일 경로 깨짐 | 아무 에러 없이 데몬 미실행 |
| Startup 폴더 비활성화 (기업 정책) | 로그인해도 데몬 안 뜸 |

**수정 내용 (2026-04-06):**
- Task Scheduler로 변경 — 로그인 트리거, 실패 시 1분마다 3회 재시도
- VBS는 Task Scheduler 실패 시에만 fallback으로 사용

**수정된 파일:**
- `setup/install.ps1` — Step 6 (line ~404)
- `src/daemon-updater.js` — bat/vbs 재생성 섹션 (line ~186)

---

## 3. JS 파일 수정 후 캐시 버스팅

**수정 파일**: `public/js/*.js` 중 하나

**같이 바꿔야 하는 것:**
- `public/orbit3d.html` — 해당 파일의 `?v=날짜-v번호` 직접 증가

**현재 방어책**: `server.js`에서 `maxAge: 0` 설정 → 서버 레벨 캐시 비활성화
**남은 위험**: Railway CDN 또는 브라우저 디스크 캐시 (Ctrl+Shift+R로 강제 새로고침 필요)

**빠른 규칙**: JS 수정 후 orbit3d.html에서 해당 `?v=` 값 날짜 업데이트

---

## 4. 토큰/인증 관련 수정

**수정 파일**: `src/auth.js` 또는 `src/auth-oauth.js`

**같이 바꿔야 하는 것:**
- `server.js` — 토큰 발급/검증 로직 (`issueApiToken`, `ADMIN_TOKENS`)
- `src/db-pg.js` — PG 테이블 스키마 변경 시 `src/db.js`도 동기화

**왜 반복됐나:**
- SQLite만 수정하고 PG 누락 → Railway 재배포 후 토큰 소실
- `src/auth.js` 수정 시 `server.js` admin 복원 로직 누락

**현재 방어책**: `7447e04` — PG 3회 재시도 + 배포 시 PG에서 ADMIN_TOKENS 복원

---

## 5. 데몬 자동 업데이트 흐름

```
git push → Railway 재배포
  → server.js 시작 시 force_update=true 등록
  → 데몬 /api/daemon/commands 폴링 (1분 내)
  → git pull + ps1 재생성 + Task Scheduler 갱신 + 재시작
```

**수정 파일**: `src/daemon-updater.js`

**같이 바꿔야 하는 것:**
- `server.js` — `/api/daemon/commands` 엔드포인트 응답 구조
- `daemon/personal-agent.js` — `daemon-updater` 모듈 import 방식

---

## 미해결 이슈 상태 (2026-04-06)

| 이슈 | 원인 | 해결 방법 |
|------|------|-----------|
| pc_DESKTOP 미연동 | OAuth만 함, PowerShell 설치 명령 미실행 | 사용자에게 직접 설치 명령 재전달 |
| pc_neonva 미연동 | 토큰 만료 or OAuth 세션 끊김 | OAuth 재로그인 후 설치 명령 재실행 |
| 설연주 데몬 꺼짐 | VBS 체인 끊김 or PC 강제종료 | 이번 배포 후 Task Scheduler로 자동 해결 예정 |
| 현욱 설치 실패 | irm\|iex 보안 차단 or 권한 문제 | 수동 설치 또는 기업 보안 예외 등록 필요 |

---

## 파일별 수정 횟수 (최근 20커밋 기준)

| 파일 | 횟수 | 주 이유 |
|------|------|---------|
| `setup/install.ps1` | 5회 | 설치 방식 변경, 인코딩, kill 로직 |
| `public/js/orbit3d-data-load.js` | 6회 | 설치 UI 변경 (install.ps1 연동) |
| `server.js` | 5회 | 토큰 복원, 자동 업데이트 |
| `src/auth.js` | 3회 | 토큰 소실 수정 |
| `daemon/personal-agent.js` | 3회 | 재시작/중복 프로세스 정리 |
| `src/daemon-updater.js` | 2회 | Startup 방식 변경 |
