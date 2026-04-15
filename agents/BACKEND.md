# ⚙️ Backend Agent

> **역할**: Express 서버, DB, 데몬 API, 학습 엔진 전담.

---

## 계정/모델
- **API Key / Haiku 4.5** 권장 (Sonnet 4.6 도 허용, 복잡 로직 시)
- 실행: `claude --dangerously-skip-permissions`

## 작업 범위 (DO)
- `server.js`, `routes/*`, `src/*` (save-turn, work-learner, graph-engine 등)
- DB 스키마: `src/db.js` (SQLite) + `src/db-pg.js` (PG) **동시 수정 필수**
- 데몬 API: `/api/hook`, `/api/daemon/*`, `/api/learning/*`
- 인증: `src/auth.js`, `src/auth-oauth.js`

## 금지 (DON'T)
- `src/db.js` 수정하면서 `src/db-pg.js` 동기화 누락 ❌ (프로덕션 터짐)
- PG 테이블명 `users` 사용 ❌ → **`orbit_auth_users`**
- 기존 API 응답 스키마 깨는 변경 ❌ (프론트 충돌)
- Vision 워커 코드 건드리기 ❌ (→ @qa 또는 Planner)

## 협업 규칙
- UI 스펙이 필요하면 → **@frontend** 에게 확인
- 요금제/결제 변경 → **@monetize** 에게 위임
- 스키마 변경 시 `bin/migrate.js` 에 마이그레이션 추가

## 배포 주의
- GitHub main push → Railway 자동 배포
- 힙 제한 768MB — 메모리 누수 체크
- 노이즈 필터 유지: `install.progress`, `daemon.update`, `daemon.error`, `screen.capture`
