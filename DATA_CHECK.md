# DATA_CHECK.md — 데이터 확인 표준 절차 (항상 이 순서로)

> **목적**: "데이터가 안 들어온다/분석이 안 된다" 할 때 PC에 가지 않고 5분 안에 원인을 좁히는 표준 runbook.
> **규칙**: 추측 금지. 아래 API를 순서대로 호출해서 숫자로 판단한다. (2026-06-12 실전 디버깅에서 확립)

## 0. 준비

```
BASE = https://mindmap-viewer-production-adb2.up.railway.app
TOK  = 마스터 분석토큰 (orbit_ 프리픽스, /api/learning·admin 조회용)
헤더 = Authorization: Bearer $TOK
```

- 조회용 API는 `orbit_` 토큰이면 통과.
- **명령 푸시**(`/api/daemon/command`, force-update)는 Railway `ADMIN_TOKENS`에 등록된 admin 토큰 필요 — 마스터 분석토큰은 403.

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
- [ ] self-healer "토큰 자기파괴 루프" 코드 수정 (지우지 말고 claim-token 재발급하게)

## 10. 서버 자체가 죽었나 (502 반복 / 데이터 전혀 안 옴) — 2026-06-17 추가
데몬 진단 전에 **서버부터** 확인. 502 반복 = 서버 OOM 크래시루프 가능성.
- `railway logs -s mindmap-viewer` → `FATAL ERROR: Reached heap limit`(OOM) 또는 크래시 확인. (railway CLI 로그인됨: dlaww584, tranquil-analysis/mindmap-viewer)
- 회생: `railway redeploy -s mindmap-viewer -y` (메모리 클리어 재시작)
- **OOM 주범**: drive-uploader 403 무한재시도 → daemon.log 8.7MB → 거대 이벤트 폭주. **해결**: railway 변수 `GOOGLE_DRIVE_CAPTURES_FOLDER_ID` 제거 → drive-config 무조건 enabled:false. 또는 `POST /api/admin/drive-toggle {enabled:false}`. ⚠️ 실행중 데몬은 재시작해야 반영(시작 때 받은 folderId로 계속 업로드).
- 부가 부하: 서버가 들어오는 이벤트를 Haiku로 `[AI분석]` → 이벤트 폭주 시 비용/부하↑. 잦은 git push=재배포 churn으로 502 악화 → 모아서 push.

## 11. 디테일 저하 (카톡/타이핑 안 보임) — keyboard.chunk 확인
예전엔 키보드 입력으로 카톡 대화까지 보였는데 안 보이면:
- `GET /api/learning/logs?userId=X&limit=150&allTypes=1` → type 분포에서 **keyboard.chunk 개수** 확인.
- keyboard.chunk=0 = 타이핑 캡처 안 됨 = 카톡/입력 디테일 없음. 원인: ①uiohook 키보드후킹 로드실패 ②데몬 크래시루프가 daemon.update/crash로 도배돼 실작업캡처 못함.
- 정상 데몬(owner)은 keyboard.chunk + screen.capture + clipboard.change 골고루. 직원 데몬이 daemon.update만 수십~수백이면 크래시루프 → 데몬 안정화부터.

## 12. 무명 계정에 이름 박기 (데이터 유지)
설치 때 이름 미입력 → userName=userId(무명). 데이터 유지한 채 이름만:
- `POST /api/admin/update-user-name {userId, name}` (admin 토큰=dlaww584 config토큰; PG+SQLite 업데이트). 재설치 불필요.
- 식별: daemon-health/logs의 userName, 또는 online 여부(꺼진 PC=그 사람). 화면/타이핑 내용으로도 식별 가능(단 idle/크래시루프면 내용 없음).
