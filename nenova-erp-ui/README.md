# NENOVA ERP UI

네노바(nenova) 내부 직원용 ERP 웹. Next.js(App Router) + TypeScript + Tailwind CSS v4.

> 임시 위치: 현재 `mindmap-viewer` 저장소 안에서 개발 중. 추후 `jayinsightfactory/nenova-erp-ui` 저장소로 폴더째 이동 예정.

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
- **대시보드** (`/dashboard`) — 오늘 주문 / 처리 대기 / 재고 부족 / 고객 KPI + 최근 주문 + 재고 알림
- **신규 주문** (`/orders`) — 주문 등록·검색·상태변경·삭제 (핵심 업무 화면)
- **재고 관리** (`/inventory`)
- **고객 관리** (`/customers`)

## 구조

```
src/
  app/
    login/            로그인
    (app)/            인증 필요 영역 (사이드바 + 상단바 셸)
      dashboard/
      orders/
      inventory/
      customers/
  components/         Sidebar, Topbar
  lib/
    auth.ts           목업 인증 (localStorage)
    store.ts          목업 데이터 (주문/재고/고객)
    nav.ts            네비게이션 정의
```

## 다음 단계

- 인증/데이터를 목업(localStorage)에서 실제 백엔드로 교체 (Orbit 서버 API 또는 자체 DB)
- 주문 → 재고 차감 연동, 입출고 기록, 거래내역
