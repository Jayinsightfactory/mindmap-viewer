# Part A — 수집 · 설치 · 운영 (Collection / Ops)

> "보다"의 입력. 관찰·수집·설치 set·상태 확인이 여기 모인다. **파일은 제자리, 이 인덱스가 경로로 가리킴.**

## 1. MOYI Agent 설치 set
| 파일 | 역할 |
|---|---|
| `setup/install-open.bat` · `/api/install-open.bat` · `/install` | 직원 표준 진입(이름매칭, 토큰 불필요) |
| `setup/install-open.ps1` | 등록 + **수집 동의 화면** + install.ps1 실행 + 자가검증 |
| `setup/install.ps1` | 메인 9단계(Node·Git·Python·소스·Defender예외·패키지·Config·Startup+Watchdog·기동·자가검증) |
| `setup/orbit-setup.iss` · `setup/build-installer.ps1` · `setup/stub.cs` | EXE 인스톨러 경로(반쯤 존재 → 완성+서명은 외부판매 시) |
| `daemon/personal-agent.js` + `src/keyboard-watcher·screen-capture·mouse-watcher·clipboard-watcher·uiohook-child` | PC 데몬(관찰·수집) |
| `src/daemon-updater·self-healer` · watchdog·NSSM | 자동복구 5중 |

## 2. 이벤트 수신 (Ingest)
| 파일 | 역할 |
|---|---|
| `server.js` `/api/hook` | 키/화면/마우스/클립 이벤트 → `events` 테이블. `_heapPressure` 시 노이즈 저장 스킵 |
| `src/ollama-analyzer.js` | 실시간 분석(Haiku 1차 기본 OFF — 비용 게이트) |

## 3. 데이터 확인 루트 (Runbook + admin API)
| 참조 | 역할 |
|---|---|
| `DATA_CHECK.md` | **표준 진단 순서**(daemon-health→capture-funnel→logs→vision/stat→§13 원격레버). PC에 안 가고 API로 판단 |
| `DAEMON_STRUCTURE.md` | 데몬/설치/복구 구조 |
| `/api/admin/pc-list` · `daemon-health` · `daemon-log` | PC·데몬 상태 원격 조회 |
| `/api/learning/capture-funnel` · `/api/vision/stat` | 수집→분석 퍼널·Vision 상태 |
| `/api/daemon/command` · `claim-token` · `force-restart` | 원격 조치(§13, config token 인증) |

## 비용/설치 관련 메모리
- 설치 경로/토큰: memory `orbit-daemon-install-deploy`
- 재설치 "토큰 무효" 오탐 수정: 커밋 810ef60 (auto-register ensureVerifiable)
- 동의 화면: 커밋 900c7a0
