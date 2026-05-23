# NENOVA ERP UI

네노바(nenova) 내부 직원용 ERP 웹. Next.js(App Router) + TypeScript + Tailwind CSS v4.

> 통합 위치: `mindmap-viewer/nenova-erp-ui`. 현재는 Orbit/Nenova 기준 저장소 안의 업무 앱으로 유지합니다.

## 실행

```bash
npm install
npm run dev    # 개발 서버
npm run build  # 프로덕션 빌드
npm run start  # 빌드 후 실행
```

## 데모 로그인

| 아이디 | 이름 | 팀 | 비밀번호 |
|--------|------|-----|----------|
| limjy | 임재용 | 영업지원 | orbit2024 |
| seol | 설연주 | 영업지원 | orbit2024 |
| kang | 강현우 | 영업지원 | orbit2024 |
| park | 박성수 | 영업팀 | orbit2024 |

## 화면

- **로그인** (`/login`)
- **대시보드** (`/dashboard`) — 녹음→견적→프로젝트→할 일 운영 허브 + AI 비서 + 주문/재고 KPI
- **AI 비서** (`/assistant`) — Claude/GPT 기반 업무 질의, 질문 템플릿, 자동화 모듈 설계
- **워크 연동** (`/kakaowork`) — 카카오워크 메시지/알림/콜백을 nenovaweb 업무 이벤트로 연결하는 설계
- **신규 주문** (`/orders`) — 주문 등록·검색·상태변경·삭제 (핵심 업무 화면)
- **재고 관리** (`/inventory`)
- **고객 관리** (`/customers`)

## AI API 연결

서버 라우트 `POST /api/assistant`가 Claude 또는 GPT로 업무 질문을 전달합니다.
키가 없으면 화면 검증용 데모 응답으로 동작합니다.

```bash
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-3-5-haiku-20241022

OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1
```

API 키는 브라우저에 노출하지 않고 Next.js 서버 라우트에서만 사용합니다.

## KakaoWork API 연결

서버 라우트 `POST /api/kakaowork/notify`가 카카오워크 메시지 발송을 담당합니다.
키가 없거나 `dryRun: true`이면 실제 발송 없이 데모 payload를 반환합니다.

```bash
KAKAOWORK_BOT_APP_KEY=...
KAKAOWORK_ADMIN_CONVERSATION_ID=...
KAKAOWORK_CALLBACK_SECRET=...
NENOVA_PUBLIC_BASE_URL=https://nenovaweb.com
```

- `GET /api/kakaowork/notify` — 연동 준비 상태 확인
- `POST /api/kakaowork/notify` — `conversationId`, `email`, `userId` 중 하나로 메시지 발송 또는 드라이런
- `POST /api/kakaowork/callback` — 카카오워크/중계 이벤트를 업무 이벤트 형태로 정규화

## 구조

```
src/
  app/
    login/            로그인
    api/assistant/    Claude/GPT 업무 질의 API
    api/kakaowork/    카카오워크 notify/callback API
    (app)/            인증 필요 영역 (사이드바 + 상단바 셸)
      dashboard/
      assistant/
      kakaowork/
      orders/
      inventory/
      customers/
  components/         Sidebar, Topbar
  lib/
    auth.ts           목업 인증 (localStorage)
    store.ts          목업 데이터 (주문/재고/고객)
    operating-plan.ts 녹음/견적/프로젝트/AI 비서 운영 설계 데이터
    kakaowork-plan.ts 카카오워크 업무 게이트 설계 데이터
    nav.ts            네비게이션 정의
```

## 다음 단계

- 인증/데이터를 목업(localStorage)에서 실제 백엔드로 교체 (Orbit 서버 API 또는 자체 DB)
- 주문 → 재고 차감 흐름을 실제 입출고 기록/거래내역 API로 확장
- 하나의 화면에서 여러 작업을 동시에 처리할 수 있도록 패널/탭/상태 카드 단위로 업무를 분리
- 예전 `Jayinsightfactory/nenova-erp-ui` 저장소의 DB 연결/API 구현은 참고 소스로만 사용하고, 새 기준은 이 폴더로 통합
- 녹음/Plaud, Google Drive, Calendar, Gmail, Contacts, Slack/Kakao, 홈택스 연동은 `operating-plan.ts`의 모듈을 기준으로 단계 구현
