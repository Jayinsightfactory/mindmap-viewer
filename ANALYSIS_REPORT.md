# 로컬 VS Git 중복 파일 분석 리포트
**작성**: 2026-04-11 | 현 계정에서 이전 계정 작업 상태 파악

## 📊 파일 분류

### ✅ Git 추적 (프로젝트 코어 파일)
```
bin/vision-worker.js          [최신 수정: 2fb9969 Vision _parseResult() 강화]
routes/script-generator.js    [최신 수정: 5344956 /stats 라우트 순서 수정 ← 방금 커밋]
server.js                     [240KB, 최신 수정: April 11]
adapters/*, cli/*, daemon/*   [각 기능별 모듈]
```

### ⚠️ 로컬만 존재 (미추적 = 임시/시도 파일)

#### 1️⃣ Python 기반 신규 기능 (recorder)
```
recorder/                     [Python PC 활동 녹화 도구, 3/22 작성]
  ├── cli.py, config.py
  ├── keyboard_capture.py, mouse_capture.py
  ├── recorder.py, player.py
  └── db_schema.py
  
routes/recording.js           [Python recorder ↔ Node.js 서버 브리지]
```
**상태**: Git 미추적 (신규 기능 개발 중?)

#### 2️⃣ DB 마이그레이션/정리 스크립트 (4/10~4/11)
```
db-cleanup.js                 [4/10 23:16] ← 임시
db-cleanup2.js                [4/10 23:24] ← 임시  
db-cleanup-resume.js          [4/11 00:32] ← 최신, 5~9단계 이어서
db-execute-cleanup.js         [4/11 00:32] ← 최신, 실행 가능한 버전?
db-fix-users.js               [4/11 00:42] ← 사용자 매핑 체크용
db-fix-users2.js              [4/11 00:43] ← 버전2
db-fix-vision-raw.js          [4/11 01:10] ← Vision raw 필드 재파싱
```
**상태**: **실행되지 않음** (DB 변경사항 미반영 가능성 높음)

#### 3️⃣ 데이터 추출 파일 (4/10 18:58)
```
data_all_report.txt           [16KB, 전체 보고서]
data_*.json, data_*_clean.json [OS, 사고방식, 이행, 아이디어, 역량 등]
raw_*.json                    [raw 데이터]
```
**상태**: 일회용 데이터 추출 (프로젝트에 불필요)

#### 4️⃣ 체크/진단 파일
```
check-users.js                [사용자 확인용]
members_check.txt             [234B]
check_db.js                   [DB 진단]
```
**상태**: 디버깅용 (정리 가능)

---

## 🔍 핵심 질문: 실제 적용 상태

### Q1: db-fix-*.js 스크립트들이 실행되었나?
```bash
# 확인 필요:
# 1. Vision raw 데이터 개수 확인
SELECT COUNT(*), COUNT(*) FILTER(WHERE raw IS NOT NULL) FROM events 
WHERE type='screen.analyzed'
```

### Q2: PC_USER_MAP이 실제로 적용되었나?
메모리: "3ee9a41 fix: PC_USER_MAP 전체 재정비 — 누락 호스트 추가 + userId 오류 수정"
→ 이것은 **git에 커밋됨** (영구적 적용)
→ db-fix-users.js는 추가 검증인 것 같음

### Q3: recorder 폴더는 뭔가?
```
발견: 신규 Python 모듈 + routes/recording.js
추정: 자동화 스크립트 생성을 위해 마우스/키보드 활동 녹화 기능 개발 중?
상태: git 미추적 → 결정 필요 (추가할지, 버릴지?)
```

### Q4: data_*.json들은?
```
추정: 기존 데이터 마이그레이션 또는 분석을 위한 임시 추출
상태: 불필요하면 정리 가능
```

---

## ✨ 권장사항

| 우선순위 | 파일 | 액션 | 이유 |
|---------|------|------|------|
| 🔴 **높음** | db-fix-vision-raw.js | **실행 필요** | 메모리의 "Vision 파이프라인 버그" 해결 위해 |
| 🔴 **높음** | recorder/ + routes/recording.js | **git 병합 결정** | 신규 기능인데 추적 안 되고 있음 |
| 🟡 **중간** | db-cleanup-resume.js | 실행 확인 | DB 정리 1~4단계 이후 5~9단계 남음 |
| 🟡 **중간** | db-fix-users*.js | 검증만 | git의 3ee9a41이 이미 적용됨 |
| 🟢 **낮음** | data_*.json, check*.js | **삭제** | 일회용 + 디버깅 파일 |

