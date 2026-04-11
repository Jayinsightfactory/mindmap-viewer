# 로컬 임시 파일 목적 분석

## 🎯 신규 기능 (Git 미추가)

### 1️⃣ `recorder/` + `routes/recording.js`
**목적**: Python 기반 PC 활동 녹화 도구 + Node.js 서버 브리지
```
recorder/                    (Python 모듈 — 3/22 작성)
  ├── recorder.py           — 마우스/키보드 입력 + 스크린샷 캡처
  ├── keyboard_capture.py   — 키 입력 추적
  ├── mouse_capture.py      — 마우스 좌표 추적
  ├── player.py             — 세션 재생
  ├── db_schema.py          — recording.db 스키마
  ├── cli.py                — Python CLI (record/list/play/export)
  └── exporter.py           — JSON 내보내기

routes/recording.js          (Node.js API 브리지 — 8개 엔드포인트)
  POST /recording/status     — 녹화 시작/종료 신호
  POST /recording/activity   — 활동 요약
  GET  /recording/sessions   — 세션 목록
  GET  /recording/sessions/:id — 세션 상세
  ... 등 8개 API
```
**상태**: ❌ **아직 git에 미추가** (신규 기능 개발 진행 중)
**역할**: 자동화 스크립트 생성에 필요한 실시간 활동 데이터 수집

---

## 🔧 DB 마이그레이션 (Git 미커밋)

### 2️⃣ `db-execute-cleanup.js` (1~4단계)
**목적**: 프로덕션 DB 정리 — imageBase64 제거 + 불필요 데이터 삭제
```
1. screen.capture 이벤트에서 imageBase64 제거 (저장 용량 절감)
2. 비학습 데이터 삭제 (daemon.update, daemon.perf.issue, healed, install.progress)
3. 7일 이전 idle 이벤트 삭제
4. 임시 테이블/레코드 정리
```
**상태**: ❌ **아직 실행 안 됨** (git에 커밋 기록 없음)
**실행 여부**: DATABASE_PUBLIC_URL 환경변수 필요

### 3️⃣ `db-cleanup-resume.js` (5~9단계)
**목적**: DB 정리 계속 (1~4 이후)
```
5. rag_documents 중복 제거
6. analytics_events 오래된 데이터 삭제
7-9. 추가 테이블 정리
```
**상태**: ❌ **아직 실행 안 됨**

### 4️⃣ `db-fix-vision-raw.js`
**목적**: Vision 데이터 재파싱 (메모리의 "65% 빈값" 버그 해결)
```
42건의 raw 필드에 잘려있는 JSON 문자열을
vision-worker.js의 _parseResult() 로직으로 재파싱하여
app, screen, activity, workCategory 필드 구조화
```
**상태**: ❌ **아직 실행 안 됨**
**목적**: script-generator가 자동화 스크립트 생성 시 높은 품질의 Vision 데이터 사용

### 5️⃣ `db-fix-users*.js` (db-fix-users.js, db-fix-users2.js)
**목적**: PC_USER_MAP 검증
```
사용자 매핑 확인 (git commit 3ee9a41에서 이미 적용됨)
→ 추가 검증용 스크립트
```
**상태**: ✅ **git에 이미 커밋됨** (3ee9a41)
**이 스크립트들**: 검증 목적이라 실행 후 결과 확인만 필요

---

## 📊 일회용 데이터 파일 (정리 가능)

### 6️⃣ 데이터 추출 파일
```
data_all_report.txt          (16KB) — 전체 보고서
data_os.json, data_os_clean.json
data_think_status*.json      — 사고방식 분석
data_transitions*.json       — 이행 패턴
data_ideas*.json             — 아이디어
data_capabilities.json       — 역량
data_health.json, data_insights.json
raw_*.json, raw_health.json, raw_summary.json
```
**상태**: ❌ **일회용** — 정리 가능
**목적**: 기존 데이터 추출 테스트 (프로젝트에 불필요)

### 7️⃣ 진단/체크 파일
```
check-users.js               — 사용자 확인
check_db.js                  — DB 진단
members_check.txt            — 멤버 리스트
```
**상태**: ❌ **디버깅용** — 정리 가능

---

## 🎬 버전 변경 추적

### db-cleanup*.js 버전들
```
db-cleanup.js          (4/10 23:16) ← 초기 버전
db-cleanup2.js         (4/10 23:24) ← 개선 버전
db-cleanup-resume.js   (4/11 00:32) ← 최신 (5~9단계 버전)
db-execute-cleanup.js  (4/11 00:32) ← 최신 (1~4단계 통합 버전)
```
**추천**: `db-execute-cleanup.js` + `db-cleanup-resume.js` 만 사용

---

## ✅ 작업 체크리스트

### 우선순위별 진행 순서

**🔴 높음 (필수)**
- [ ] 1. Vision 파이프라인 완전 수정
  - `db-fix-vision-raw.js` 실행 — 42건 raw 재파싱
  - `bin/vision-worker.js` 추가 개선 (필요시)
- [ ] 2. 이전 작업 적용 상태 확인
  - `db-execute-cleanup.js` 실행 여부 확인
  - `db-cleanup-resume.js` 실행 여부 확인
  - PC_USER_MAP 적용 검증

**🟡 중간 (신기능)**
- [ ] 3. recorder 완성 + git 추가
  - 기능 테스트
  - server.js에 라우트 마운트
  - production 배포

**🟢 낮음 (정리)**
- [ ] 4. 임시 파일 정리
  - `data_*.json` 삭제
  - `check*.js` 삭제
  - `.gitignore` 추가

---

## 핵심 질문

1. **db-execute-cleanup.js를 이미 실행했나?**
   - Git에 커밋이 없으니 아직 안 된 것 같음
   - 실행 확인 필요

2. **recorder 신규 기능을 프로젝트에 포함할 건가?**
   - 자동화 스크립트 생성을 위해 필요해 보임
   - 완성도 확인 + git 추가 결정 필요

3. **db-fix-vision-raw.js 실행 우선순위는?**
   - Vision 데이터 품질 개선 (메모리의 핵심 버그 해결)
   - script-generator 정확도 향상
   - 지금 바로 실행 추천
