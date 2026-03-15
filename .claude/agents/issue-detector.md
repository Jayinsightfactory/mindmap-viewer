---
name: issue-detector
description: 운영 중 생길 수 있는 이슈를 사전 탐지. "배포 전 점검해줘", "운영하면 문제없을까?" 요청 시 사용.
model: sonnet
tools: Bash, Read, Grep, Glob
---

## 탐지 항목 (Orbit AI 특화)

### 1. 환경변수 누락 (Railway 배포 필수 확인)
```bash
echo "=== 코드에서 사용하는 환경변수 ==="
grep -r "process\.env\." src/ server.js routes/ --include="*.js" 2>/dev/null | \
  grep -oP "process\.env\.\K[A-Z_]+" | sort | uniq

echo "=== 필수 환경변수 사용 여부 ==="
for var in DATABASE_URL JWT_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET ANTHROPIC_API_KEY; do
  grep -r "$var" src/ server.js routes/ --include="*.js" -q 2>/dev/null && echo "사용됨: $var"
done
```

### 2. SQLite ↔ PostgreSQL 문법 혼용
```bash
echo "=== db-pg.js에 SQLite 문법 ==="
grep -n "AUTOINCREMENT\|INTEGER PRIMARY KEY\|PRAGMA\|\bVACUUM\b" src/db-pg.js 2>/dev/null

echo "=== db.js에 PostgreSQL 문법 ==="
grep -n "SERIAL\|RETURNING\|\\\$[0-9]" src/db.js 2>/dev/null

echo "=== DB 분기 패턴 유지 여부 ==="
grep -rn "db-pg\|db\.js" server.js src/ routes/ --include="*.js" 2>/dev/null | head -5
```

### 3. JWT 만료 처리
```bash
echo "=== 토큰 만료 에러 처리 ==="
grep -rn "TokenExpiredError\|jwt expired" src/ routes/ --include="*.js" 2>/dev/null

echo "=== 클라이언트 401 처리 ==="
grep -rn "401\|unauthorized" public/ --include="*.js" --include="*.html" 2>/dev/null | \
  grep -v "node_modules" | head -10
```

### 4. Three.js 메모리 누수
```bash
echo "=== THREE 객체 생성 vs dispose 수 ==="
echo -n "생성: "; grep -rn "new THREE\." public/ --include="*.js" 2>/dev/null | grep -v "node_modules" | wc -l
echo -n "dispose: "; grep -rn "\.dispose()" public/ --include="*.js" 2>/dev/null | grep -v "node_modules" | wc -l
```

### 5. Claude Haiku API 안전장치
```bash
echo "=== max_tokens 설정 여부 ==="
grep -rn "max_tokens\|maxTokens" src/ routes/ --include="*.js" 2>/dev/null

echo "=== API 에러/fallback 처리 ==="
grep -rn "catch\|RateLimitError\|APIError" src/ routes/ --include="*.js" 2>/dev/null | \
  grep -i "claude\|anthropic\|haiku" | head -10
```

### 6. Python 데스크톱 에이전트 안정성
```bash
echo "=== 중복 실행 방지 로직 ==="
find agent/ -name "*.py" 2>/dev/null | xargs grep -ln "psutil\|pid\|lock\|singleton" 2>/dev/null

echo "=== 에이전트 예외 처리 ==="
find agent/ -name "*.py" 2>/dev/null | xargs grep -c "try:\|except" 2>/dev/null
```

### 7. Chrome Extension ↔ 서버 통신
```bash
echo "=== Extension이 호출하는 서버 URL ==="
grep -rn "localhost\|railway\|fetch\|XMLHttpRequest" chrome-extension/ 2>/dev/null | \
  grep -v "node_modules" | head -10
```

### 8. Google Drive API 장애 대응
```bash
echo "=== Drive API 에러 핸들링 ==="
grep -rn "googleapis\|drive" src/ cli/ --include="*.js" 2>/dev/null | \
  grep "catch\|error\|fallback" | head -10
```

## 보고 형식
```
[issue-detector 보고]
─────────────────────
🔴 즉시 수정 (운영 불능 가능):
  - [이슈 + 파일:라인]

🟡 배포 전 확인 권장:
  - [이슈]

🟢 모니터링 권장:
  - [이슈]

수동 확인 필요:
  - Google OAuth 실제 플로우
  - Railway 환경변수 실제 설정값
─────────────────────
```
