# Orbit / Nenova Workspace

이 저장소는 Orbit 작업 허브와 Nenova 업무 도구를 함께 관리하는 기준 저장소입니다.

## 기준 GitHub

| 구분 | 위치 | 용도 |
|------|------|------|
| 기준 저장소 | `Jayinsightfactory/mindmap-viewer` | 현재 작업, 배포, PR 기준 |

로컬에서는 `origin`을 `Jayinsightfactory/mindmap-viewer`로 사용합니다.
삭제된 `dlaww-wq` 원격은 사용하지 않습니다.

## 흩어진 저장소 정리

| 저장소 | 현재 판단 | 처리 방향 |
|--------|-----------|-----------|
| `Jayinsightfactory/mindmap-viewer` | 활성 기준 저장소 | 모든 Orbit/Nenova 작업을 여기로 모읍니다. |
| `Jayinsightfactory/nenova-erp-ui` | 예전 ERP 웹 작업 소스 | DB 연결/API/업무 로직을 참고해서 `nenova-erp-ui/`와 Orbit API로 흡수합니다. 새 작업 push는 하지 않습니다. |
| `Jayinsightfactory/nenovakakao` | 카카오톡/카카오워크 수집 도구 소스 | 필요한 수집/미러/시트 로직만 `tools/`, `scripts/`, `routes/` 쪽으로 단계적으로 흡수합니다. |
| `Jayinsightfactory/nenovaweb` | 빈 저장소 | 사용하지 않습니다. |

비네노바 주제의 저장소는 별도 프로젝트로 보고, 이 작업 허브에는 가져오지 않습니다.

## 운영 원칙

- 작업을 시작하기 전에 `WORK_MEMORY.md`와 관련 단어 검색 결과를 확인합니다.
- 사용자의 반복 수정 요청과 대화 핵심은 `WORK_MEMORY.md`에 누적하고 삭제하지 않습니다.
- 저장소를 기능마다 쪼개지 않고, 하나의 작업 허브 안에서 여러 업무 흐름을 관리합니다.
- 하나의 화면이 여러 업무를 동시에 다룰 수 있으므로, "페이지 1개 = 작업 1개"로 보지 않습니다.
- 화면은 업무 단위의 패널, 탭, 상태 카드로 나누고, 코드는 앱/라우트/도메인 모듈 단위로 나눕니다.
- 큰 기능은 브랜치에서 작업한 뒤 `main`으로 합칩니다.
- `main`은 항상 실행 가능한 상태를 유지합니다.

## 현재 작업 영역

| 영역 | 위치 | 상태 |
|------|------|------|
| Orbit 작업 허브 | `public/`, `routes/`, `src/` | 기존 운영 중심 |
| Nenova ERP UI | `nenova-erp-ui/` | Next.js 앱, 내부 직원용 ERP 화면 |
| Nenova 전산 분석 | `public/nenova-dashboard.html`, `routes/nenova-*` | 전산/카톡/비전 교차 분석 |
| 자동화 파이프라인 | `routes/autotest.js`, `scripts/`, `setup/` | 네노바 업무 자동화/설치/테스트 |

## 브랜치 정리

| 브랜치 | 의미 |
|--------|------|
| `main` | 기준 배포 브랜치 |
| `workspace/nenova-erp-ui-unified` | PR #4로 `main`에 병합 완료 |
| `claude/start-nenovaweb-work-YD5FE` | Nenova ERP UI 원 작업 브랜치. 참고용 |
| `claude/continue-work-Od1oe` | 차수 확정 관리 등 이전 실험 브랜치. 참고용 |

Claude가 만든 임시 브랜치는 작업 소스처럼 보고, 최종 흐름은 기준 저장소의 `main`으로 합칩니다.

## Nenova ERP UI 실행

```bash
cd nenova-erp-ui
npm install
npm run dev
```

기본 주소는 `http://localhost:3000/login`입니다.

데모 계정은 `nenova-erp-ui/README.md`를 기준으로 봅니다.

## 다음 통합 방향

- Nenova ERP UI를 별도 저장소로 떼기보다 이 저장소 안의 업무 앱으로 유지합니다.
- ERP UI의 목업 `localStorage` 데이터를 Orbit/Nenova API와 연결합니다.
- 예전 `Jayinsightfactory/nenova-erp-ui`의 MS-SQL/JWT/API 구현은 필요한 부분만 선별해서 가져옵니다.
- `Jayinsightfactory/nenovakakao`의 카카오 수집기는 Orbit 자동화 파이프라인과 겹치는 부분부터 흡수합니다.
- 동시에 진행되는 작업은 GitHub 브랜치보다 이 파일과 `PROGRESS.md`에 먼저 기록합니다.
