# Orbit AI — PROGRESS

> 최종 업데이트: 2026-04-13 (세션2)

---

## 작업 (2026-04-13) — 네노바 자동화 파이프라인 완성

### 1. launcher.pyw × Orbit 연동 (완료)
- launcher.pyw에 Orbit parse API 호출 코드 삽입 (`/api/automation/parse`)
- .env에 `ORBIT_SERVER` 추가
- 패치 위치 오류(IndentationError) → 수동 수정으로 해결
- launcher 정상 실행 확인 ✅

### 2. parse API 버그 수정 (완료)
- `bill_arrival` regex: `항공` 하드코딩 제거, multiline 지원 (`[\s\S]`)
- 영어 항공사명 (KOREAN AIR LINES) 정상 감지
- 테스트: boxes 90→95 변경 감지 + `arrivalAlert.type: "changed"` ✅

### 3. master_customers upsert 안정화 (완료)
- UNIQUE constraint 의존 → check/update/insert 방식으로 변경
- nenova_key 기준 안정적 동기화

### 남은 작업
- launcher.pyw Orbit 연동 코드 재삽입 (올바른 위치: classify_and_log_delta 이후)
- 실제 카톡 방 감시 → parse → 이슈 자동생성 E2E 테스트

---

## 최근 작업 (2026-04-12) — 32커밋

### 1. 데몬 자가복구 시스템 (완료)
- `REMOTE_URL` 상수 → `getRemoteUrl()` 동적 읽기
- 3중 자가복구: git remote URL + config serverUrl + 기동 시 즉시 체크
- 서버 5회 연속 실패 → git fetch 직접 비교 fallback
- install.ps1 / install-bank.ps1 재설치 시 git remote 자동 수리
- 잔존 dlaww@kicda.com / sparkling-determination 6개 파일 일괄 치환

### 2. 프로세스 마이닝 + 레코더 통합 (완료)
- recorder SQLite (mouse/keyboard/screenshot) → PG events 병합
- recording.js: vision-learning 클릭 동기화 + 통합 현황 API
- mouse_capture.py: Windows ctypes 포그라운드 윈도우 감지
- process-mining.js: fetchMergedEvents() — PG+SQLite 타임스탬프 병합

### 3. 카톡 분석 + 구글시트 연동 (완료)
- 구글시트 직접 읽기 (서비스계정 Railway 이스케이프 완전 해결)
- 3소스 교차 분석: 카톡 + 네노바 전산 + Vision 캡처
- 토탈분석 7탭 + 네노바 + 비전 교차분석 엔드포인트
- nenova 전산 직접 조회 (거래처/주문/출하/상품)

### 4. 네노바 자동화 파이프라인 (완료)
- 카톡 파서 재설계 (실제 메시지 포맷 기반: change_order/bill_arrival/MEL)
- Descr 통용명 자동 동기화 (master_customers)
- bill_arrival 트래킹 + KakaoWork 알림 (입고딜레이/수량변경 감지)
- nenova_key 기준 upsert, custKey null 버그 수정

### 5. 이슈 태스킹 시스템 (완료)
- `/api/biz-issues` — 카톡 파싱 이벤트에서 이슈 자동 생성
- `/issues.html` — 칸반 UI (백로그/진행/완료)
- KakaoWork 알림 연동

### 6. UI/UX (완료)
- 설치코드 발급 버튼 — 클릭 시 Google 계정 + PC 정보 뱃지 표시 후 토큰 포함 명령어 생성
- Orbit Company OS 통합 허브 (orbit-hub.html)
- 자동화 청사진 페이지 (automation-blueprint.html)

---

## 인프라 현황

| 항목 | 상태 |
|------|------|
| Railway 배포 | 정상 (main push → 자동배포) |
| 데몬 자가복구 | 3중 복구 + git fallback |
| 구글시트 연동 | 서비스계정 파싱 해결 완료 |
| nenova 4대 PC | 수동 재설치 1회 필요 (이후 자동) |

---

## 다음 단계
- nenova 4대 PC 설치코드 재실행 (발급 버튼으로 간편화됨)
- Vision 정밀 분석 고도화 (캡처→화면해독→자동화지점)
- 자동화 스크립트 자동 생성 엔진 (PAD/pyautogui/AHK)
