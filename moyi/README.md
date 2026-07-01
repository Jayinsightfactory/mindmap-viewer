# MOYI — 프로그램 구성 인덱스 (2부 구조)

> 이 폴더는 **문서 인덱스**다. 실제 코드는 옮기지 않는다(라이브 require·정적경로 보존, 코드 복사=중복 드리프트라 금지).
> 각 부분의 실제 파일은 아래 하위 README가 **경로로 가리킨다**. 구조가 바뀌면 여기 인덱스만 갱신.

## 두 부분
| 부분 | 역할 | 인덱스 |
|---|---|---|
| **Part A — 수집·설치·운영** | 관찰·수집·설치 set·데이터 확인 루트 ("보다"의 입력) | [collection/README.md](collection/README.md) |
| **Part B — 지능·시각화** | 온톨로지·흐름 API·옵시디언 뷰·에이전트 ("배우다·보이다") | [intelligence/README.md](intelligence/README.md) |

## 공통 (Cross-cutting)
- **멀티테넌트**: `workspace_id`(기본 `nenova`, `?tenant=`) — 전 조회 격리(T0a 완료).
- **인증**: MASTER 토큰 → SSO(예정, MOYI_PLATFORM_PLAN §8-3).
- **브랜드**: 화면 표기 MOYI / 내부 식별자 orbit 유지(기존 데몬 호환).
- **배포**: git push main → Railway 자동배포.

## 상위 기획 문서 (repo 밖, 홈)
- `C:\Users\USER\NENOVA_SOLUTION_AUDIT.md` — MOYI 스위트·모듈·완성도·누락 ①~⑩
- `C:\Users\USER\MOYI_PLATFORM_PLAN.md` — 코어/커넥터/버티컬 · §8 멀티테넌트 · §9 설치프로그램 set
- repo: `ORBIT_3D_REDESIGN_GUIDE.md`(옵시디언×3D), `DATA_CHECK.md`(확인 런북), `DAEMON_STRUCTURE.md`
