# 두 PC 동기화 가이드

> PC A (Mac, 이 컴퓨터) ↔ GitHub ↔ PC B (작업 중인 다른 PC)

---

## 기본 원칙

- **코드는 항상 GitHub 통해서** 이동 (USB, 카톡 파일 전송 X)
- **작업 시작 전**: 반드시 pull 먼저
- **작업 끝나면**: 반드시 push
- **같은 파일 동시 수정 금지**: 충돌(conflict) 발생 원인

---

## Mac (이 PC) 사용법

### 작업 시작할 때
```bash
cd ~/Desktop/mindmap-viewer
bash sync-pull.sh
```

### 작업 끝났을 때
```bash
cd ~/Desktop/mindmap-viewer
bash sync-push.sh
# 커밋 메시지 입력 (예: "feat: 사용자 노드 타입 추가")
```

---

## Windows PC (다른 PC) 사용법

### 작업 시작할 때
```
sync-pull.bat 더블클릭
```

### 작업 끝났을 때
```
sync-push.bat 더블클릭
```

---

## 처음 다른 PC에서 시작할 때 (최초 1회)

```bash
git clone https://github.com/Jayinsightfactory/mindmap-viewer.git
cd mindmap-viewer
npm install
```

---

## 충돌(conflict) 났을 때

```bash
# 충돌 파일 확인
git status

# 충돌 표시 예시 (server.js 안에 이런 표시가 생김)
<<<<<<< HEAD
  내가 수정한 코드
=======
  상대방이 수정한 코드
>>>>>>> origin/main

# 해결 방법:
# 1. 파일 열어서 원하는 코드만 남기고 <<<, ===, >>> 표시 삭제
# 2. git add server.js
# 3. git commit -m "resolve: 충돌 해결"
# 4. git push
```

---

## 커밋 메시지 규칙

```
feat:     새 기능 추가
fix:      버그 수정
refactor: 코드 구조 개선 (기능 변화 없음)
docs:     문서 수정
style:    UI/CSS 변경
db:       DB 스키마 변경
chore:    설정, 패키지 등 잡일

예시:
  feat: PostgreSQL 연결 추가
  fix: 채널 필터 누락 버그 수정
  docs: MIGRATION_PLAN 업데이트
```

---

## 브랜치 전략 (나중에 팀 커지면)

```
main      ← 항상 배포 가능한 상태 유지
dev       ← 개발 작업 브랜치
feature/* ← 큰 기능 단위 작업
```

지금은 main에 직접 push해도 됨.
팀원 생기면 dev 브랜치 도입 고려.

---

## 자주 쓰는 Git 명령어

```bash
git status              # 현재 상태 확인
git log --oneline -10   # 최근 10개 커밋 보기
git diff                # 변경사항 미리보기
git stash               # 임시 저장 (pull 전에 급하게 치울 때)
git stash pop           # 임시 저장 복원
```
