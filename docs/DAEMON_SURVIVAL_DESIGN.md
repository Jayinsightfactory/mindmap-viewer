# DAEMON_SURVIVAL_DESIGN.md — 데몬 생존 설계 (보안프로그램·전원·업데이트 다운 방지)

> 2026-10-21 작성. 직원 PC 데몬(Orbit/MOYI FDE)이 "보안 프로그램·전원·구버전 업데이트" 때문에
> 반복해서 죽는 문제를, **(1) 설치 시 예방 → (2) 발생 시 자가복구 → (3) 복구 불가 시 원인코드 보고**
> 3계층으로 막는다. 기존 구조는 [DAEMON_STRUCTURE.md](DAEMON_STRUCTURE.md), 데이터 안 들어올 때
> 디버깅은 [DATA_CHECK.md](../DATA_CHECK.md). 이 문서는 그 위에 **덧붙인** 생존 계층만 설명한다.

---

## 0. 원인군(실측) → 대응 매핑

| 원인군 | 실측 사례 | 대응 계층 |
|---|---|---|
| 제3백신/은행보안이 node·python·훅·캡처를 강제 종료 | 알약 제거 후 Defender가 keyboard.chunk 차단(김빛나), 박성수 훅 차단 | ① 설치 예방 + ④ 원인코드 |
| 재부팅/전원복귀 후 미기동 | 아드리아나 10-12 하트비트 후 무응답 | ② 자동시작·복구 |
| 구버전 크래시 루프(새 배포 직후 반복 급사) | 강명훈 daemon.crash 19건/시간 | ③ last-known-good 롤백 |
| 프로세스 급사(네이티브 abort/OOM) | RSS 2.1GB OOM, 네이티브 종료코드 | ②③④ |

핵심 원칙(가드레일): **재부팅·재설치를 1차 해법으로 내지 않는다. 광역 taskkill·`git reset --hard` 로
남의 작업 날리지 않는다. 전 PC 원격 명령은 카나리 1대 후 확대.** COM `New-Object` 금지(GetActiveObject만),
창 없는 서비스/작업스케줄러 등록만.

---

## ① 설치 시 예방 — 보안프로그램 감지·예외 + 서비스 복구옵션

파일: `setup/install.ps1`

### 1-1. 백신·은행보안 스캔 → 서버 보고 (`[4.5/9]`)
- Defender 는 기존대로 `Add-MpPreference` 자가예외(관리자 권한 시). 폴더·node.exe·python.exe.
- **제3백신**(AhnLab V3·알약 등)·**은행 보안**(nProtect/AnySign/TouchEn/Wizvera/Veraport/INISAFE/
  MagicLine/RaonSecure/SoftCamp 등)은 설치기가 예외 등록할 공개 API 가 없다 → **감지만** 한다:
  - 보안센터(`root/SecurityCenter2`) 등록 백신 제품명 + 실행 중 프로세스명을 서명 부분일치로 스캔.
  - 결과를 `install.diag` 이벤트의 `security` 블록으로 서버 전송:
    `{ thirdPartyAv[], bankSecurity[], needsManualExclusion[], defenderExcluded }`.
  - `needsManualExclusion` 에 `av:<제품>` / `bank:<프로세스>` 로 남겨 **사장님이 해당 PC 만** 보안
    담당자에게 예외 요청하면 되게 한다. **강제 종료·삭제·설정 변경은 하지 않는다**(법적·보안 리스크).
- 조회: `GET /api/admin/install-diag?hostname=` 의 `security` 필드.

### 1-2. 서비스 복구옵션 3단계 (NSSM + SCM)
- NSSM: `AppExit Default Restart`, `AppRestartDelay 5000`, **`AppThrottle 0`**(반복 급사해도 NSSM 자체
  재시작 억제 안 함).
- **SCM `sc failure` 3단계 지연 증가**: `reset= 86400 actions= restart/5000/restart/30000/restart/120000`
  + `failureflag 1`. → 1차 5초 / 2차 30초 / 3차 이후 120초. NSSM 프로세스가 통째로 죽거나 서비스가
  OS 레벨에서 멈춰도 SCM 이 지수적으로 버티며 재시작. 상태는 `install.diag.svcRecovery`
  (`3stage-5s-30s-120s` / `nssm-only` / `no-nssm`).

### 1-3. 전원복귀·로그온 2중화 (기존 유지 + 확인)
- 예약작업 설정에 `-StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`
  `-RestartCount 5 -RestartInterval 1min` 가 이미 있음 → **놓친 트리거/전원복귀 후 자동 기동**.
- OrbitWatchdog 는 AtLogOn + **2분 주기 반복** → 재부팅/절전복귀 후 최대 2분 내 워커 생존 확인·복구.
- 자동시작 5중(Task데몬/Task감시/NSSM/HKCU Run/Startup lnk)은 `install.diag` 로 PC별 상태 보고.

---

## ② 자가복구 — 감독 루프 + 서킷브레이커 (기존) + 급사 부검

파일: `setup/guardian-start-daemon.ps1`(워커 감독), `setup/guardian-watchdog.ps1`(라이프라인)

- start-daemon 루프가 워커(personal-agent) 사망 시 재spawn. 10초 폴링.
- watchdog(NSSM LocalSystem, 2분)이 워커 死검사+재시작, 매 사이클 Defender 자가예외 재등록.
- **서킷브레이커(기존)**: 15초 미만 급사가 180초 안에 5회 연속이면 `.safe-mode`(TTL)로 10분 백오프
  → poison 입력/네이티브 kill 이 CPU 무한 소모 못 하게.

---

## ③ 복구 불가 시 — last-known-good 롤백 (신규)

파일: `setup/guardian-start-daemon.ps1` + `setup/guardian-watchdog.ps1` + `setup/install.ps1`(OrbitCodeSync)

이 저장소는 git 배포(= 코드가 곧 번들)라 **last-known-good 번들 = 마지막으로 정상 돈 git 커밋**이다.

- **good 기록**: 워커가 `HEALTHY_SEC`(300초) 이상 산 런이 끝나면 그때 HEAD 를
  `~/.orbit/last-known-good.sha` 에 기록.
- **롤백 트리거**: 서킷브레이커가 트립했는데 ①현재 HEAD 가 `ROLLBACK_WINDOW_SEC`(1시간) 안에 커밋된
  **새 배포**이고 ②그와 다른 good SHA 가 있으면 → `git reset --hard <good>` + `~/.orbit/.code-pin`
  `{good,bad,at}` 기록. HEAD 가 오래됐으면(=코드가 아니라 환경 문제) 롤백하지 않고 보고만 한다.
- **핀 존중**: watchdog `Guardian-GitSync` 와 OrbitCodeSync 가 매번 핀을 확인한다.
  - `origin/main == bad`(아직 수정 안 올라옴) → `reset --hard good` 유지.
  - `origin/main != bad`(**운영자가 수정 배포**) → 핀 삭제 후 origin/main 으로 앞으로 당김.
  - → **영구 strand 없음**: 고친 커밋을 올리면 자동으로 최신으로 복귀.
- **배포 경로**: `src/daemon-updater.js` 가 update 시 `watchdog.ps1` + **`start-daemon.ps1`**(신규 추가)을
  템플릿에서 재생성 → 재설치 없이 생존 로직이 PC 에 반영.

---

## ④ 부검 로그 — 원인 코드 (신규)

파일: `src/boot-diag.js` (기존 boot-stage/crash-moment/stderr 3겹 위에 분류 추가)

- `classifyCause(tails)` 가 직전 런 꼬리(종료코드·stderr·단계)에서 **원인 코드**를 뽑아
  `daemon.crashmoment` 이벤트의 `causeCode`/`causeDetail` 로 서버에 올린다.
- 원인 코드:

| code | 의미 |
|---|---|
| `graceful` | 정상 종료(code=0) |
| `crashloop` | 수퍼바이저 서킷브레이커 명시(구버전 크래시 루프) — 롤백 대상/결과 포함 |
| `oom` | 메모리 한도/힙 소진 |
| `av-quarantine` | 네이티브 종료 + 핵심 모듈 파일 소실(AV 가 node_modules/.node 격리 의심) |
| `missing-file` | require 실패/ENOENT |
| `killed-by:<proc>` | 종료 직전 보안 프로세스 기록 |
| `token-expired` | 401/토큰 무효 전송 실패 |
| `port` | EADDRINUSE 등 포트 충돌 |
| `native-crash` | 음수/대형 종료코드(0xC0000005 등) 원인 미상 |
| `unknown` | 분류 불가 |

- start-daemon 서킷브레이커는 트립 시 `crash-moment.log` 에 `[cause] code=crashloop ...` 를 남기고
  `/api/hook` 로 1회 직접 보고(베스트에포트) → 네트워크 실패해도 다음 기동 때 boot-diag 가 재전송.

---

## ⑤ 검증 (오너 PC DESKTOP-S4S2HMU, 2026-10-21)

| 항목 | 방법 | 결과 |
|---|---|---|
| 강제 종료 자동복구 | `taskkill /PID <personal-agent> /F` **단일 PID만** | **54.1초** 후 새 PID 로 재기동, 6초 뒤 안정 확인 |
| 크래시루프 롤백 | 격리 git 저장소(good→bad), 새 배포+good 존재 | HEAD→good 롤백 + `.code-pin{good,bad}` 기록 ✅ |
| 핀 유지 | origin/main 이 아직 bad | target=good 유지(되감지 않음) ✅ |
| 핀 해제 | 운영자 수정 커밋으로 origin/main 전진 | 핀 삭제 + origin/main 당김(strand 없음) ✅ |
| 원인코드 분류 | 종료코드/stderr 9종 단위테스트 | graceful/oom/port/token-expired/av-quarantine/native-crash 정확 ✅ |
| 보안 스캔 | 오너 PC 실측 | AV=Windows Defender 1종, 제3백신/은행보안 **미탐지**, needsManualExclusion=[] |
| 서비스 복구옵션 | `sc failure` 구문 | 표준 구문. 오너 PC 엔 OrbitWatchdogSvc 미설치라 설치 시 적용 |

**미검증(라이브 리스크로 생략)**: 오너 PC **전체 재설치**는 실행하지 않았다. 재설치는 라이브 데몬(PID
53832)·Defender 예외·NSSM·예약작업을 다시 건드려 수집을 중단시키고 code-sync 와 충돌할 수 있어,
가드레일(재설치 1차 해법 금지)과 "오너 PC 수집 중단 방지"에 어긋나기 때문이다. 재설치를 직접 돌리려면:

```powershell
$env:ORBIT_AUTO_REINSTALL='1'; irm https://mindmap-viewer-production-adb2.up.railway.app/setup/install-open.ps1 | iex
```

성공 판정 한 줄: 설치 끝 `[9/9]` 의 `자동시작: Task데몬=True ...` + `install.diag.svcRecovery=3stage-...`
+ `security.needsManualExclusion` 목록. (단, install-open 은 iex 경로 — AMSI/BOM 주의, 내부적으로
-OutFile+-File 로 받음.)

참고: 오너 PC 는 현재 `~/mindmap-viewer` 가 Defender 예외에 **미등록**(`defenderExcluded=False`)이다.
이 PC는 관리자 Vision 워커도 도는 메인이므로, 다음 재설치/업데이트 때 자가예외가 적용된다.

---

## ⑥ 카나리 (사장님 승인 전 — force-update 보내지 않음)

- **추천 1대: 아드리아나 PC `DESKTOP-05VLRN1`**(10-12 이후 무응답, 재등록으로 새 user_id
  `MN1D726A373D679F9A`). 생존 로직(롤백·부검·서비스복구)이 가장 필요한 PC.
- 반영 경로: PR→main 머지 후 **아침 부팅/OrbitCodeSync(10분) 자동**이 기본. 즉시 반영이 필요하면
  카나리 1대에만 원격 `update`(워커/watchdog 처리, start-daemon.ps1·watchdog.ps1 템플릿 재생성):

  ```
  POST /api/daemon/command  {"hostname":"DESKTOP-05VLRN1","action":"update"}
  ```

  (admin=config 토큰. 확대는 이 1대에서 `daemon.crashmoment.causeCode`·복구 확인 후 전 PC.)

---

## 변경 파일 요약 (수술식, server.js/routes 불변)

- `setup/install.ps1` — 보안 스캔→install.diag.security, SCM 3단계 복구, last-known-good 시드, 묵은 핀 해제, OrbitCodeSync 핀 존중.
- `setup/guardian-start-daemon.ps1` — HEALTHY good 기록, 크래시루프 롤백+핀, code=crashloop 보고.
- `setup/guardian-watchdog.ps1` — Guardian-GitSync 핀 존중.
- `src/boot-diag.js` — `classifyCause` + causeCode/causeDetail.
- `src/daemon-updater.js` — update 시 start-daemon.ps1 템플릿 재생성(재설치 없이 배포).
