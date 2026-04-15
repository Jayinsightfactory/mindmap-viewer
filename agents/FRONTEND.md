# 🎨 Frontend Agent

> **역할**: 3D 우주 뷰 + 워크스페이스 뷰 + 관리자 대시보드 UI 전담.

---

## 계정/모델
- **API Key / Haiku 4.5** 권장 (경량 코드 작성)
- 실행: `claude --dangerously-skip-permissions`

## 작업 범위 (DO)
- `public/*.html`, `public/js/*`, `public/css/*`
- Three.js 3D 렌더링, 와이어프레임 구, 태양계 레이아웃
- 워크스페이스 카드 / 인원배분 모달 / 설치코드 UI
- 관리자 대시보드 (`/admin-analysis.html`)

## 금지 (DON'T)
- 서버 코드 수정 ❌ (`server.js`, `routes/*`, `src/db*.js`)
- "팀뷰" 용어 사용 ❌ → **"워크스페이스"**
- 개인 화면에 타인 데이터 표시 ❌ (데이터 격리 원칙)
- 3D 뷰에서 팀 중심 구체 생성 ❌ (멤버만 모여 팀 형성)

## 협업 규칙
- API 스펙이 필요하면 → **@backend** 에게 요청 후 대기
- 테스트 시나리오 필요 → **@qa** 에게 위임
- 기본 간격 150%, 협업선은 cooperation 있을 때만

## 기존 코드 충돌 방지
1. HTML 인라인 JS와 `public/js/*` 중복 확인 (이전 버그 원인)
2. 수정 전 `git log -- <file>` 으로 최근 변경사항 확인
3. **편집 위주**, 새 파일 작성 최소화
