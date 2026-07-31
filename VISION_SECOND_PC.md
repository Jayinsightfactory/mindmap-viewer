# 비전 분석 전용 PC 세팅 지침 (정리본)

> 목적: 화면 캡처 Vision 분석을 **두 번째 PC**에서 돌려 처리량·깊이를 늘린다.
> 대상: `bin/vision-worker.js` (server-queue 모드).

## ⚠️ 먼저 — "클로드 앱 쓰면 CLI 필요없지?" → **아니요, CLI 필요합니다**

- **Claude 데스크톱 앱(채팅 GUI)** ≠ **Claude CLI(명령어 `claude`)**.
- 워커는 GUI 앱을 **자동으로 조종할 수 없습니다.** 프로그램이 호출하려면 **CLI**(또는 API 키)가 있어야 합니다.
- **하지만 돈은 안 듭니다** — CLI는 **데스크톱 앱과 같은 Max/Pro 구독으로 로그인**합니다. 구독을 명령줄에서 쓰는 것뿐, 토큰당 추가 비용 0.
- 정리: **구독은 그대로 쓰되, "claude" 명령줄 도구를 설치·로그인**하면 됩니다.

## 0. 모델 — **자동 라우팅** (핵심=Sonnet, 나머지=Haiku)

워커에 **화면 가치별 모델 라우터**가 기본 ON. 앱/창제목을 보고:
- **nenova·ECOUNT·주문/출고/발주/견적/재고/엑셀·정산·통관·검수·분배** → **Sonnet**(추출 품질 핵심)
- 그 외(브라우저·카톡·탐색기·일반) → **Haiku**(대량·저가치, ~1/10 비용)
→ Sonnet 호출을 핵심 화면 ~20~30%로 줄여 **사용량 5~10배 절감**, 품질은 유지.

조정 env(선택): `VISION_MODEL_HIGH`(기본 sonnet)·`VISION_MODEL_BULK`(기본 haiku)·`VISION_HIGH_VALUE_RE`(핵심앱 정규식)·`VISION_MODEL_ROUTER=off`(단일 모델로).

## 1. 준비물

| 항목 | 확인 |
|---|---|
| Windows 10/11 (또는 macOS) | — |
| **Node.js 18+** | `node -v` |
| **git** | `git --version` |
| **Claude CLI** (구독 로그인) | 설치 후 `claude` |
| 서버 토큰 (orbit_ 프리픽스) | 소유자에게 받기 |

> ⚠️ **소유자 PC와 다른 Claude 계정으로 로그인할 것.** 같은 Max 계정을 두 PC가 쓰면 사용량 한도(quota)를 나눠 서로 굶는다. (별도 계정이 없으면 한 PC만 돌리는 게 나음.)

## 2. 설치 (한 번만)

```powershell
# 1) Claude CLI 설치 + 로그인 (구독 계정 = 데스크톱 앱과 동일 계정, 무과금)
npm install -g @anthropic-ai/claude-code
claude            # 최초 실행 → 브라우저 로그인(구독 선택). 끝나면 'where claude'로 경로 확인.

# 2) 저장소 클론 + 의존성
git clone https://github.com/Jayinsightfactory/mindmap-viewer.git
cd mindmap-viewer
npm install

# 3) 서버 인증 파일 생성:  %USERPROFILE%\.orbit-config.json
```

`%USERPROFILE%\.orbit-config.json`:
```json
{
  "token": "orbit_여기에_분석토큰",
  "serverUrl": "https://mindmap-viewer-production-adb2.up.railway.app"
}
```

## 3. 실행

```powershell
cd C:\...\mindmap-viewer

$env:ANTHROPIC_API_KEY = ''          # 비워야 CLI(무과금) 경로 사용
$env:ORBIT_CLI_RESERVE_PCT = '10'    # 전용 PC라 최소만 남기고 빨리 처리
# 모델은 라우터가 자동(핵심=Sonnet/나머지=Haiku). 전부 한 모델로 강제하려면 VISION_MODEL_ROUTER='off' + VISION_CLI_MODEL 지정.

node bin/vision-worker.js --server-queue --flush
```

- `--server-queue`: 서버 큐에서 이미지 받아 분석 · `--flush`: 즉시 분석(야간대기 안 함).
- 더 자주 처리: `$env:VISION_POLL_MS='120000'`(2분), `$env:VISION_BATCH_N='40'`.
- 창을 닫으면 멈춤 → 계속 돌리려면 §5 백그라운드 등록.

## 4. 잘 되는지 확인 (숫자)

```
BASE = https://mindmap-viewer-production-adb2.up.railway.app   (헤더: Authorization: Bearer <토큰>)
- GET /api/vision/stat                     → processed 증가?
- GET /api/learning/capture-funnel?days=1  → analyzed 상승?
- 로컬 ~/.orbit/vision-worker.log           → "처리 N건" (UTF-16 인코딩 주의)
```
- 콘솔/로그에 `[quota]`가 계속 뜨면 = 그 계정 한도 도달 → 다른 계정 필요 or `ORBIT_CLI_RESERVE_PCT` 조정.
- `Claude CLI 미발견` 뜨면 = CLI 설치·로그인 안 됨(§2-1 다시).

## 5. 상시 백그라운드 (선택)

작업 스케줄러 → "로그인 시 실행" 작업 등록, 동작:
```
powershell -NoProfile -WindowStyle Hidden -Command "cd C:\...\mindmap-viewer; $env:VISION_CLI_MODEL='sonnet'; node bin/vision-worker.js --server-queue --flush *> $env:USERPROFILE\.orbit\vision-worker.log"
```

## 6. 백로그·다른PC 처리 — 스풀 파이프라인으로 해결됨 (2026-07-30 갱신)

> 이전엔 "서버 큐(인메모리)가 옛 캡처를 버려 백로그 못 잡음"이 한계였다. 아래로 해결.

- **워커 모드 3종**: `--server-queue`(은퇴)·`--local`(이 PC `~/.orbit/captures/*.png` 직접 분석)·**`--spool`**(전 직원 백로그를 서버 볼륨 스풀에서 소진).
- **스풀 경로**: 각 데몬 `uploadPendingToSpool`(3분, 최신순, 트리거·상태 71%컷, 사이드카.json으로 app/창제목 보존) → `POST /api/vision/spool`(Railway 볼륨 디스크, 사용자당 300상한, OOM안전) → owner `--spool` 워커가 최신순으로 list→분석→`screen.analyzed`→delete. owner PC는 `~/.orbit/.no-spool-upload` 마커로 업로드 스킵(--local이 직접 처리).
- **좌표융합**: 서버가 spool/file에 `_clicksForCapture`로 캡처직전 클릭 첨부 → vision이 fields[].clickXY(pyautogui 실행좌표) 생성. 최신순이라 클릭 15분버퍼 살아있는 동안 처리.
- 검증(2026-07-30): 전직원 백로그 완전소진(스풀 0), clickXY 부착 확인(설연주 14/50, 카톡 Sonnet).
- 상시화: HKCU\Run + 18:00 스케줄 `OrbitVisionLocal`·`OrbitVisionSpool`. 상세는 [[vision-cli-worker-local]] 메모리·WORK_MEMORY.md 2026-07-30.
