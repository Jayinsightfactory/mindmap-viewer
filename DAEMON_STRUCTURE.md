# DAEMON_STRUCTURE.md — Orbit 데몬 전체 구조 (작업 전 필독)

> **규칙**: 데몬/설치/복구/모니터링 관련 질문·지시를 받으면 **이 문서를 먼저 읽고** 시작한다.
> 추측으로 새로 만들지 말고, 아래 기존 구조/모듈/채널을 먼저 활용한다. (2026-06-18 작성)
> 데이터가 "안 들어온다"류 디버깅은 [DATA_CHECK.md](DATA_CHECK.md)를 함께 본다.

---

## 1. 프로세스 모델
- **`daemon/personal-agent.js`** = 메인 데몬 프로세스. 부팅/로그인 시 기동, 모든 모듈을 로드·`.start()`.
- **`daemon/local-buffer.js`** = 로컬 이벤트 버퍼.
- 데이터는 각 모듈 → **`POST /api/hook`** (서버 Railway)로 전송.

## 2. 수집 모듈 (src/) — 무엇을 보내나
| 모듈 | 이벤트 type | 핵심 |
|---|---|---|
| `keyboard-watcher.js` | **keyboard.chunk** | 키 입력 → `_rawBuffer`(로컬) → 분석. **payload `analyzed` 객체의 `inputText`로 원본 전송**(옵션2). 앱컨텍스트·통계(rawStats/typingPatterns) 포함 |
| `screen-capture.js` | **screen.capture** | 이벤트 기반 캡처. 캡처 방식: ①PIL(python) ②pyautogui ③PowerShell CopyFromScreen 폴백(검은화면 가능). `_shouldSendImage`로 이미지 전송 throttle |
| `mouse-watcher.js` | **mouse.chunk** | 마우스 좌표 → 60초마다 전송 |
| `tool-profiler.js` | — | 앱별 사용패턴 학습 + 수집전략 |
| `workflow-learner.js` | — | 업무 워크플로우 자동 학습 |
| `data-quality.js` | (유틸) | `normalizeAppName`, `sanitizeWindowTitle` |
| secureCollector / bankToggle | secure.activity / bank.* | 은행/보안 앱 감지·최소수집 |

## 3. 운영/복구 모듈
| 모듈/스크립트 | 역할 |
|---|---|
| `src/daemon-updater.js` (=**워커**) | **60초마다** `/api/daemon/commands` 폴링 + 자동업데이트(평일 09:30/13:00/15:00). 명령 직접실행: gitpull-worker·reclone-worker·exec·config·capture-config. `GUARDIAN_ONLY_ACTIONS=['reinstall']`(restart/update는 워커 직접). `pullAndRestart`=git reset+process.exit("최신"이면 skip) |
| `src/self-healer.js` | 모듈 에러시 자동 재시작. 60min 캡처없으면 screen-capture 재시작. 토큰은 보존(자기파괴 금지, 4e8aa0a) |
| `src/drive-uploader.js` | Google Drive 업로드 — **현재 OFF**(서비스계정 quota 403). 분석=서버큐+CLI워커 |
| `setup/guardian-watchdog.ps1` (=**라이프라인**) | **NSSM LocalSystem 서비스가 2분마다** 실행. ①AV자가예외 ②worker 死검사+재시작(WMI 폴백) ③guardian-alive heartbeat ④자가재설치(30분 死시 install.ps1 -File). 명령처리: exec/restart/update/reinstall/config. ⚠️ NSSM 설치 성공이 라이프라인 생명줄 |
| `setup/guardian-start-daemon.ps1` | start-daemon.ps1 — ps1 루프로 personal-agent 재respawn |

## 4. 자동시작·복구 5중 (install.ps1이 등록)
1. **OrbitDaemon** schtasks (AtLogOn) — 데몬 기동
2. **OrbitWatchdog** (2분 주기) — worker 死검사+명령폴링 *(30분→2분, 2026-06-18)*
3. **OrbitWatchdogSvc** NSSM 서비스 (LocalSystem=admin, 2분 loop) — 라이프라인 본체
4. **OrbitCodeSync** (10분) — `git reset --hard origin/main` + HEAD 변경시 데몬 재시작
5. **HKCU\Run** + **Startup 바로가기** — 로그인시 백업 기동

## 5. 명령 채널 (원격 제어)
- 큐: `POST /api/daemon/command {hostname, action}` (admin=config 토큰 dlaww584. 마스터 orbit_은 403). PG `orbit_daemon_commands` 영속(TTL 없음).
- **워커(60s)와 watchdog(2분)이 같은 큐를 폴링** → 서버가 GET때 큐 비움 → 먼저 폴링한 쪽이 가져감.
- 액션: `gitpull-worker`(워커전용, "최신"이면 skip) / `restart`·`update`(워커직접/watchdog) / `reclone-worker`(⚠️Windows EBUSY 실패) / `exec`(워커=execSync 블로킹·비대화식이어야, watchdog=install패턴 차단) / `config`·`capture-config`.
- **워커 죽으면**: gitpull-worker 등 워커전용 명령은 영영 안 먹음 → **watchdog이 처리하는 update/restart/exec**를 써라.

## 6. 설치 흐름
- 직원: **`install-open.ps1`**(irm|iex) → 이름 입력 → `auto-register` → **`install.ps1`을 -OutFile로 받아 -File 실행**(iex 금지: AMSI/BOM 깨짐). UI는 "업무 학습 도구"로 reframe(추적용어 제거).
- `install.ps1` [4.5/9] **Defender 자가예외**(Add-MpPreference, admin 필요). 끝에 **install.diag** 이벤트(av/uiohook/screenCap/자동시작/부하) → `GET /api/admin/install-diag?hostname=`.
- 자가재설치/비대화식: `$env:ORBIT_AUTO_REINSTALL='1'` (Pause-Exit 스킵).

## 7. 데이터 흐름 요약
```
PC 모듈 → POST /api/hook → 서버(PG events)
  → work-learner(세션/분류/자동화점수) → /api/learning/* → 대시보드(/work-logs, /admin-analysis)
  → screen.capture 이미지 → CLI 비전워커(owner PC, --night 19~08시, 무과금) → screen.analyzed
```

## 8. 핵심 함정 (전부 실사고)
1. **워커 死 + watchdog만 생존** = gitpull-worker 안 먹음 → update/exec 써라. 명령 백로그 폭주(auto-doctor)가 워커 죽이는 악순환 → 가드(39923a3)·purge.
2. **reclone-worker는 Windows에서 실패**(in-use 디렉터리 rename EBUSY).
3. **install은 iex 금지** — AMSI/BOM. -OutFile+-File.
4. **AV(알약/Defender)가 데몬 죽임** — 라이프라인 AV자가예외(admin=NSSM)로 예방. 새 설치는 Defender 예외 자동.
5. **코드 push ≠ 데몬 반영** — 재시작/CodeSync 전까지 구코드. owner repo는 CodeSync가 git reset(편집→commit→push 한 호흡).
6. **잦은 push = 재배포 502** — 설치/명령 중 register 실패. 모아서 push.
7. **키보드 내용은 통계 아니라 inputText**(payload). 한글은 QWERTY 물리키라 work-logs 두벌식 역변환 토글로 봄.
