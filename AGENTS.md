# AGENTS.md — mindmap-viewer (Orbit 데몬·서버, 네노바 사내 운영) — Codex/Claude 공용

먼저 읽기: `CLAUDE.md`(절대 규칙·골모드), `DAEMON_STRUCTURE.md`, `DATA_CHECK.md`("데이터 안 들어온다"면 이 순서로), `WORK_MEMORY.md` 최근 항목. 전역 규칙은 `~/.codex/AGENTS.md`.

## 이 저장소의 함정
- **main push = 즉시 배포**(Railway) + 직원 PC 데몬이 git 동기화로 재시작될 수 있음. 커밋은 바로 push(로컬 미푸시 커밋은 `~/.orbit/code-sync.ps1`이 지움).
- 재배포 전 `orbit_auth_tokens` 규모 확인(콜드부팅 OOM 이력). 502/크래시루프면 `railway logs`로 OOM 먼저.
- 직원 PC 데몬 코드에서 COM `New-Object` 금지(GetActiveObject만). 창 띄우는 명령(cmd/nssm 창) 금지 → `Invoke-NssmHidden` 패턴.
- 원격 exec 는 `powershell -EncodedCommand <b64>`로(워커가 `-Command "<원문>"`으로 감싸 여러 줄 스크립트가 조용히 깨짐). hostname은 lifeline에 찍힌 표기 그대로(대소문자 큐 분열).
- "안 보임 ≠ 구버전/고장": daemon-health는 켜진 PC만. 재부팅/재설치 먼저 말하지 말고 자가복구(force-restart/update, 코드 수정)로.
- 크롬 확장은 비도메인 PC에서 강제설치가 무시됨 → 웹(ECOUNT·네노바웹) 조작 수집은 `setup/uia-recorder.ps1`(주소창 URL·ControlType.Id 비교). 녹화기 새 코드는 PC 재부팅 또는 녹화기 프로세스 재시작부터.
- 비전 분석은 사장님 PC CLI 워커(Max 구독, $0). 사용량 70% 가드·`~/.orbit/quota-hold`. 서버 `ANTHROPIC_API_KEY`는 비워 둘 것.
- 분석 제외: 사장님(owner, 옛 표시명 임재용)·손지윤.
- MOYI 고객용 설치는 `/api/install-moyi.*`(추가만). 네노바 직원용 `/api/install-open.bat`·`install.ps1`은 바이트 동일 유지.

## 검증
- 배포 후 `/api/admin/daemon-health`, `/api/learning/capture-funnel?days=1`, `logs?type=screen.analyzed`로 유입 전후 비교.
