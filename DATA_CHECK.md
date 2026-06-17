# DATA_CHECK.md — 데이터 확인 표준 절차 (항상 이 순서로)

> **목적**: "데이터가 안 들어온다/분석이 안 된다" 할 때 PC에 가지 않고 5분 안에 원인을 좁히는 표준 runbook.
> **규칙**: 추측 금지. 아래 API를 순서대로 호출해서 숫자로 판단한다. (2026-06-12 실전 디버깅에서 확립)

---

## ★ "데이터 확인" 트리거 — 사용자가 이 말을 하면 이 순서로 (재부팅 언급 금지)

> 사용자가 **"데이터 확인 / 데이터 현황 / 데이터 / 재점검"** 이라고 하면 추측·재부팅·재설치를 **먼저 말하지 말고** 아래를 순서대로 실행해서 **숫자표**로 답한다. (2026-06-17 확립 — 같은 실수 반복 방지)

1. **§1 daemon-health** → 연결 데몬 목록 + `uptime`(15분 미만=의심) + `state`.
2. **§3 capture-funnel?days=3** → 유저별 `cap/anal/useful`. **이게 "데이터 나오나"의 1차 판정.**
3. 문제 유저만 **§11 learning/logs?allTypes=1** → `keyboard.chunk`(타이핑/카톡) + `screen.capture` 개수.
   - ⚠️ `keyboard.chunk`/`screen.capture`는 **`/api/learning/logs`에만** 있다. `/api/daemon/events`엔 daemon.* 만 있음(여기서 kbd 0이라고 "데이터 없음" 단정 금지 — 실사고 2026-06-17).
   - ⚠️ logs limit이 작으면 **daemon.update 폭주가 윈도를 채워** keyboard.chunk가 안 보일 수 있다(크래시루프 징후이지 "키보드 없음" 아님). limit 키우거나 type 지정.
4. **판정표**:

| funnel | logs | 판정 | 조치 |
|---|---|---|---|
| cap 많음·anal 있음 | kbd/scr 있음 | **정상** | 끝 |
| cap 있음·anal 0 | scr 있음 | Vision 미처리 | §4 (서버워커/CLI) |
| cap 0~few | daemon.update 수십~수백 | **크래시루프** | §13 원격 재시작 레버 |
| uptime 계속 상승 + daemon.crash 반복 + kbd0·scr0 | — | **좀비(heartbeat만 생존, 내부 모듈 죽음)** | §13-Z (원격 불가 — 전원주기 대기) |

5. 크래시루프/좀비면 → **재부팅 말고 §13 레버 순서대로**. 그래도 안 되면 **"직원이 밤에 끄고 아침에 켤 때 최신코드로 자동 회생"**으로 안내(수동 재부팅 요구 아님).

---

## 0. 준비

```
BASE = https://mindmap-viewer-production-adb2.up.railway.app
TOK  = 마스터 분석토큰 (orbit_ 프리픽스, /api/learning·admin 조회용)
헤더 = Authorization: Bearer $TOK
```

- 조회용 API는 `orbit_` 토큰이면 통과.
- **명령 푸시**(`/api/daemon/command`)는 `resolveAdmin` 통과 토큰 필요. **마스터 분석토큰(orbit_…)은 403** ("admin only"). **`~/.orbit-config.json`의 token(=admin 이메일 dlaww584 발급분)은 통과** — update-user-name·daemon/command에 이걸 써라. (force-restart/force-update는 무인증이지만 'ALL'큐+40분 TTL+consumedHosts라 진단 GET이 오염시켜 잘 안 닿음 → per-host `/api/daemon/command`를 써라. 2026-06-17 확립)

## 1. 데몬 생존 확인 — `GET /api/admin/daemon-health`

- **켜져서 실행 중인 데몬만** 나온다. 안 보임 = PC 꺼짐일 수 있음. **"안 보임 ≠ 구버전/고장"**.
- 볼 것: `uptime`(분 단위로 짧으면 크래시루프), `memMB`(1GB+ 비정상), `state`(dead), `modules.*.errorCount`.

## 2. PC↔계정 매핑 — `GET /api/admin/pc-list`

- hostname **대소문자 중복** 주의 (NEONVA vs neonva 사고). userId·event_count로 교차확인.
- **임시 ID 판별**: 같은 hostname에 userId가 여러 개면, `last_seen`이 최신인 ID가 현재 데몬의 ID. 그 ID가 실유저인지 모르면 `claim-token`이 "userId not found"를 주는지로 판별(임시 ID는 orbit_auth_users에 없음).

## 3. 수집→분석 퍼널 — `GET /api/learning/capture-funnel?days=N`

유저별 `captures / analyzed / useful` 카운트. 패턴별 해석:

| 패턴 | 의미 | 다음 단계 |
|---|---|---|
| cap 0 | 캡처 자체가 안 옴 (PC 꺼짐/데몬 죽음/토큰 401) | §1, §6 |
| cap 많음, anal 0 | 이미지가 Vision까지 못 감 | §4, §5 |
| anal 있음, useful 0 | 분석은 되는데 빈 결과 | 프롬프트/이미지 품질 |

## 4. Vision 파이프라인 상태 — `GET /api/vision/stat`

`worker.{running, apiKeyConfigured, processed, failed, queueSize, lastSkipReason, lastError, startedAt}`

| 증상 | 원인 |
|---|---|
| `lastError: 401 invalid x-api-key` | **ANTHROPIC_API_KEY 무효** → Railway 변수 교체 + 재배포. `apiKeyConfigured:true`는 "값이 있다"일 뿐 유효성 보장 아님 (2026-06-12 실사고) |
| `lastSkipReason: empty_queue` 지속 | 데몬이 이미지를 안 보냄 (§5, §6) |
| `startedAt`이 안 바뀜 | Railway 재배포 미완료 — 환경변수 변경은 재배포 후에만 반영 |
| `processed`만 오르고 funnel anal 0 | screen.analyzed **저장 경로** 버그 (2026-06-13 발견, 미해결 시 §추적 참조) |

**서버 파이프라인만 격리 테스트**: `POST /api/vision/queue-push` (orbit_ 토큰, body `{imageBase64, app, hostname, userId}`)
→ 14초 후 stat에서 processed/failed 변화 확인. 401=키문제, 400 "Could not process image"=더미 이미지라 정상(인증은 통과).

## 5. 원본 이벤트로 데몬 진단 — `GET /api/learning/logs?userId=X&type=screen.capture&limit=200`

- **trigger 분포**가 데몬 건강의 지문:
  - `startup`이 수십 % = **크래시루프** (startup은 데몬 시작 때만 발생. 6분 간격 startup = 6분마다 재시작)
  - 정상이면 keyboard_flush/mouse_click 위주
- 주의: 이 API는 data_json을 요약 필드로 변환해 반환 — `capturePolicy` 같은 원시 필드는 안 보임.

## 6. 데몬 크래시/명령 이력 — `GET /api/daemon/events?limit=200`

- `daemon.crash`의 `crashLog`에 사망 직전 로그 — "update start: auto: dead NNNmin" 반복=업데이터 자기재시작 루프, "uiohook 로드 실패"=키보드훅 고장.
- `guardian-config` 초당 수십 건 = guardian 폭주.

## 7. 토큰 문제 (캡처는 로컬에 쌓이는데 서버에 안 올 때)

1. PC의 `~/.orbit-config.json`에 `token` 필드가 **있는지** — self-healer가 401 치유한다며 **토큰을 지워버리는 자기파괴 루프** 있음 (로그: "token cache cleared" + "치유 #N: send_errors_50" 반복)
2. 토큰 유효성: `GET /api/auth/verify` (Bearer 데몬토큰) → 401이면 무효
3. 재발급: `POST /api/daemon/claim-token` body `{token: "orbit_"+랜덤48hex, userId: 실유저ID}` → ok면 config에 token·userId 기록 → **데몬 재시작 불필요** (전송마다 config 새로 읽음)
4. "userId not found" = 그 ID는 임시 ID. §2로 실유저 ID 찾아서 claim.

## 8. 로컬(PC에서 직접) 확인 — owner PC만 해당

- `~/.orbit/daemon-self.log` (UTF-8 정상) / `daemon.log` (인코딩 깨짐) — "401", "치유", "vision-queue" grep
- `~/.orbit/captures/*.png` — 캡처가 로컬에 쌓이는지, 파일 크기(평균 ~330KB, base64 +33%, 서버 limit 2MB)
- `~/.orbit/capture-config.json` — 학습 에이전트가 푸시한 **정책 오버라이드** (`triggerAdjustments`가 코드 정책을 덮어씀 — sendImage:false가 들어있으면 이미지 전면 차단)
- 데몬 재시작: `Stop-Process` 후 `schtasks /run /tn OrbitDaemon` (watchdog이 어차피 살림)

## 9. 함정 모음 (전부 실사고)

1. **daemon-health에 없음 ≠ 고장** — 퇴근으로 PC 꺼진 것일 수 있음
2. **hostname 대소문자 중복** — verify 단일 결과로 단정 금지, pc-list 교차확인
3. **apiKeyConfigured:true ≠ 키 유효** — 실제 호출(queue-push)로 검증
4. **환경변수 교체 ≠ 즉시 반영** — 재배포 완료(`startedAt` 갱신) 확인
5. **코드 push ≠ 데몬 반영** — OrbitCodeSync는 파일만 갱신, **데몬 재시작 전까지 메모리의 구코드 실행**
6. **설치 직후인데 임시 ID** — "hostname 매칭 없음" 설치는 임시 ID로 돌아가고 토큰 재발급 불가 → §7
7. **이 PC(owner) repo는 OrbitCodeSync가 30분마다 `git reset --hard origin/main`** — 서버코드 수정은 편집→검증→commit→push를 한 호흡에

## 추적 중인 미해결

- [ ] vision worker `processed` 증가했는데 `screen.analyzed` 이벤트 미저장 (2026-06-13 00시 발견)
- [ ] 설연주(neonva): uiohook 로드 실패 + guardian-config 폭주 + daemon.log 85MB
- [ ] 강현우(DESKTOP-T09911T): 업데이터 "dead NNNmin" 자기재시작 루프, state dead
- [x] self-healer "토큰 자기파괴 루프" — 4e8aa0a로 no-op 처리(토큰 보존)
- [x] restart/update 위임 블랙홀 — 5ec0814로 워커 직접 처리 (§13)
- [ ] watchdog 좀비 미탐지 — WMI 死검사를 PID/내부-liveness(keyboard.chunk·screen.capture 0)로 교체 (§13-Z durable TODO)
- [ ] 좀비 데몬(김빛나 NENOVA2025, 정재훈 nenova): 원격 회생 불가 확인 → 전원주기 대기. 아침 PC 켤 때 회생 검증 필요

## 10. 서버 자체가 죽었나 (502 반복 / 데이터 전혀 안 옴) — 2026-06-17 추가
데몬 진단 전에 **서버부터** 확인. 502 반복 = 서버 OOM 크래시루프 가능성.
- `railway logs -s mindmap-viewer` → `FATAL ERROR: Reached heap limit`(OOM) 또는 크래시 확인. (railway CLI 로그인됨: dlaww584, tranquil-analysis/mindmap-viewer)
- 회생: `railway redeploy -s mindmap-viewer -y` (메모리 클리어 재시작)
- **OOM 주범 ①(Drive)**: drive-uploader 403 무한재시도 → daemon.log 8.7MB → 거대 이벤트 폭주. **해결**: railway 변수 `GOOGLE_DRIVE_CAPTURES_FOLDER_ID` 제거 → drive-config 무조건 enabled:false. 또는 `POST /api/admin/drive-toggle {enabled:false}`. ⚠️ 실행중 데몬은 재시작해야 반영(시작 때 받은 folderId로 계속 업로드).
- **OOM 주범 ②(daemon.update 폭주)** — 2026-06-17 실사고: **crash-loop 데몬들이 `daemon.update`를 초당 수십건 쏟아냄** → PG 연결풀 고갈(`railway logs`에 `[hook] insertEvent FAIL: timeout exceeded when trying to connect ... type= daemon.update` 도배) → 그 사이 들어온 이벤트가 메모리에 적체 → heap 760MB OOM. **해결(커밋 05ff191)**: `/api/hook`에서 `_heapPressure`(500MB+)일 때 고볼륨 노이즈(`daemon.update`/`daemon.heartbeat`/`daemon.log.snapshot`/`daemon.perf.issue`) **저장 스킵**(NOISE_TYPES라 그래프 영향 0, daemon.update 이메일알림은 별도 루프라 유지). **근본 차단은 데몬 크래시루프 자체를 멈추는 것**(§13으로 재시작·픽스 반영, 안 되면 전원주기).
- **⭐ 메타 규칙**: **여러 직원 데이터가 동시에 다 안 들어오면 = 개별 PC 문제 아니라 서버 OOM부터 의심.** PC 하나하나 디버깅 전에 §10(railway logs)을 먼저 본다. (2026-06-17: 김빛나 PC를 의심했는데 실제론 서버 OOM으로 전원이 send_errors였음.)
- 부가 부하: 서버가 들어오는 이벤트를 Haiku로 `[AI분석]` → 이벤트 폭주 시 비용/부하↑. **잦은 git push=재배포 churn으로 502 악화 → 반드시 모아서 push**(2026-06-17 커밋 4연속 푸시로 502 유발한 실수).

## 11. 디테일 저하 (카톡/타이핑 안 보임) — keyboard.chunk 확인
예전엔 키보드 입력으로 카톡 대화까지 보였는데 안 보이면:
- `GET /api/learning/logs?userId=X&limit=150&allTypes=1` → type 분포에서 **keyboard.chunk 개수** 확인.
- keyboard.chunk=0 = 타이핑 캡처 안 됨 = 카톡/입력 디테일 없음. 원인: ①uiohook 키보드후킹 로드실패 ②데몬 크래시루프가 daemon.update/crash로 도배돼 실작업캡처 못함.
- 정상 데몬(owner)은 keyboard.chunk + screen.capture + clipboard.change 골고루. 직원 데몬이 daemon.update만 수십~수백이면 크래시루프 → 데몬 안정화부터.

## 13. 원격 재시작 레버 (재부팅 금지) — 2026-06-17 확립

데몬이 구코드로 돌아 픽스가 반영 안 될 때(§9-5), **PC 안 가고** 재시작시키는 방법. **인증=config token(§0).**

**구조 함정 (왜 force-restart가 안 닿았나):**
- 워커(daemon-updater, 60초)와 watchdog(guardian-watchdog.ps1, 30분)이 **같은 큐**(`GET /api/daemon/commands?hostname=`)를 폴링하는데 **서버가 GET 때 큐를 비운다** → 자주 폴링하는 워커가 거의 항상 먼저 가로챔.
- (2026-06-17 이전 버그) `restart`/`update`는 `GUARDIAN_ONLY_ACTIONS`라 워커가 **"guardian한테 넘김"만 보고하고 소비** → watchdog은 빈 큐 → **영영 재시작 못함(블랙홀)**. → **커밋 5ec0814에서 `GUARDIAN_ONLY_ACTIONS=['reinstall']`로 축소, 워커가 restart/update 직접 처리**(process.exit→start-daemon.ps1 루프 재respawn / pullAndRestart).

**레버 사다리 (위에서부터):**
1. `POST /api/daemon/command {hostname, action:"gitpull-worker"}` — 워커 직접 실행 `pullAndRestart`. **단 git이 "이미 최신"이면 재시작 skip**(OrbitCodeSync가 파일 맞춰놨으면 no-op). → **새 커밋 1개라도 푸시한 뒤** 보내면 "최신 아님"이라 git reset+재시작함. ✅ 2026-06-17 정재훈(nenova) 이걸로 재시작 성공(87m→1m).
2. `action:"restart"`(즉시 process.exit) / `"update"`(pullAndRestart) — **5ec0814 반영된 데몬부터** 직접 먹음(그 전 데몬은 위임 블랙홀).
3. `action:"reclone-worker"` — ⚠️ **Windows에선 실패**. `fs.renameSync(ROOT,backup)`로 시작하는데 실행 중 데몬이 repo 파일을 잡아 EBUSY → 조용히 throw, 재시작 안 됨(2026-06-17 김빛나 확인). 쓰지 마라.
4. `action:"exec", command:"<powershell>"` — watchdog·워커 둘 다 실행. install 패턴은 차단됨.
5. 확인: `GET /api/daemon/events?limit=80` 에서 `update_start`/`update_skip`/`command_executed`/`guardian-restart` 가 뜨면 닿은 것. daemon-health `uptime` 리셋이 최종 증거.

**레버 다 소진했는데도 구코드 데몬이면**(gitpull "최신" skip + restart 블랙홀 + reclone Windows실패 + 워커 크래시루프) → **막다른 길. 그 PC는 다음 전원주기(직원이 밤에 끄고 아침에 켤 때) start-daemon.ps1이 새 프로세스로 5ec0814 기동하면서 회생**하고, 그 다음부턴 restart 레버가 직접 먹는다(2026-06-17 김빛나 NENOVA2025가 이 케이스).

### 13-Z. 좀비(원격 불가) — 전원주기만 회생
**증상**: `uptime` 계속 상승(메인 프로세스 안 죽음) + `daemon.crash` 30분 간격(watchdog WMI 오탐) + `keyboard.chunk`/`screen.capture` 0 + 워커가 어떤 명령도 실행 안 함(events에 update_*/command_* 전무).
**원인**: 하나의 personal-agent 프로세스가 **heartbeat 타이머만 살고 내부 모듈(업데이터 폴링·uiohook 키보드훅·screen-capture)은 죽은** 상태. watchdog `Guardian-RestartWorker`는 **WMI CommandLine 매칭**으로 죽이는데 그게 안 보여서(권한/null) 못 죽이고, health-check는 heartbeat 보고 "정상"이라 안 건드림.
**조치**: 원격 명령 안 닿음(실행기가 죽음). **직원이 PC 끄고 켜면**(밤→아침) start-daemon.ps1이 새 프로세스로 최신코드 기동 → 자동 회생. **수동 재부팅 요구하지 말 것** — 자연 전원주기로 풀린다.
**durable TODO**: watchdog가 (a) WMI 대신 PID/포트로 死검사, (b) "N분간 keyboard.chunk·screen.capture 0 = 내부死"로 판정해 PID kill+respawn 하도록. (현재 미적용 — 적용돼도 그 데몬은 한 번 재시작돼야 반영)

## 12. 무명 계정에 이름 박기 (데이터 유지)
설치 때 이름 미입력 → userName=userId(무명). 데이터 유지한 채 이름만:
- `POST /api/admin/update-user-name {userId, name}` (admin 토큰=dlaww584 config토큰; PG+SQLite 업데이트). 재설치 불필요.
- 식별: daemon-health/logs의 userName, 또는 online 여부(꺼진 PC=그 사람). 화면/타이핑 내용으로도 식별 가능(단 idle/크래시루프면 내용 없음).
