# 배포 가이드

## Railway (권장 — PostgreSQL 포함)

### 1단계: Railway 프로젝트 생성

1. [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. `dlaww-wq/mindmap-viewer` 선택

### 2단계: PostgreSQL 추가

Railway 대시보드 → "+ New" → Database → PostgreSQL 추가
→ `DATABASE_URL` 환경변수가 자동으로 설정됨

### 3단계: 환경변수 설정

Railway 대시보드 → 서비스 클릭 → Variables:

```
NODE_ENV=production
PORT=4747
DATABASE_URL=${{Postgres.DATABASE_URL}}   ← Railway가 자동 연결
```

### 4단계: 배포

```bash
# railway.json이 이미 설정되어 있음
git push origin main  # 자동 배포 트리거
```

배포 완료 후 `https://your-app.railway.app/health` 에서 상태 확인

---

## Render (무료 플랜)

```bash
# render.yaml이 이미 설정되어 있음
# Render 대시보드 → New → Blueprint → GitHub 연결
```

환경변수 추가:
```
NODE_ENV=production
```

SQLite는 디스크에 영구 저장됨 (render.yaml의 disk 설정 참조)

---

## Docker (자체 서버)

### SQLite 버전
```bash
docker-compose up -d
# http://localhost:4747
```

### PostgreSQL 버전
```bash
# .env 파일에 DATABASE_URL 설정
echo "DATABASE_URL=postgresql://user:pass@localhost:5432/mindmap" >> .env
docker-compose up -d
```

---

## 로컬 개발

```bash
cp .env.example .env
npm install
node server.js
# http://localhost:4747        — 기존 마인드맵
# http://localhost:4747/orbit  — 행성계 UI
```

---

## 환경변수 전체 목록

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `4747` | 서버 포트 |
| `DATABASE_URL` | (없음) | PostgreSQL URL. 없으면 SQLite 자동 사용 |
| `NODE_ENV` | `development` | 운영 환경 |
| `MINDMAP_CHANNEL` | `default` | 기본 채널명 |
| `MINDMAP_MEMBER` | (hostname) | 멤버 이름 |

---

## Orbit 행성계 UI

배포 후 `/orbit.html` 경로로 접근:
```
https://your-app.railway.app/orbit.html
```

- 기존 마인드맵: `/`
- 행성계 UI: `/orbit.html`
- API: `/api/graph`, `/api/stats`, `/health`
