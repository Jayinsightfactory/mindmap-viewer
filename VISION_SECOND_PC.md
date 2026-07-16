# 비전 분석 전용 PC 세팅 지침 (정리본)

> 목적: 화면 캡처 Vision 분석을 **두 번째 PC**에서 돌려 처리량·깊이를 늘린다.
> 대상: `bin/vision-worker.js` (server-queue 모드).

## ⚠️ 먼저 — "클로드 앱 쓰면 CLI 필요없지?" → **아니요, CLI 필요합니다**

- **Claude 데스크톱 앱(채팅 GUI)** ≠ **Claude CLI(명령어 `claude`)**.
- 워커는 GUI 앱을 **자동으로 조종할 수 없습니다.** 프로그램이 호출하려면 **CLI**(또는 API 키)가 있어야 합니다.
- **하지만 돈은 안 듭니다** — CLI는 **데스크톱 앱과 같은 Max/Pro 구독으로 로그인**합니다. 구독을 명령줄에서 쓰는 것뿐, 토큰당 추가 비용 0.
- 정리: **구독은 그대로 쓰되, "claude" 명령줄 도구를 설치·로그인**하면 됩니다.

## 0. 모델 — **Sonnet** (Haiku 아님)

한글 ERP/카톡/엑셀 화면을 읽어 거래처·품목·절차를 **구조 추출**하는 작업 → Sonnet이 확실히 강함.
이번 프로젝트의 병목이 **추출 품질(커버리지)**이라 Haiku로 낮추면 얕게 뽑혀 문제 답습. 구독 CLI면 비용 0이라 낮출 이유도 없음.

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
$env:VISION_CLI_MODEL   = 'sonnet'   # 모델 지정(권장)
$env:ORBIT_CLI_RESERVE_PCT = '10'    # 전용 PC라 최소만 남기고 빨리 처리

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

## 6. 현실 — "과거 전부"는 별도

- 서버 큐는 **인메모리·사용자당 6장 상한**이라, **분석 못 하고 지나간 옛 캡처는 이미 버려짐**(서버에 없음).
- 두 번째 PC가 늘리는 건 **지금부터의 실시간 스트림 처리량·품질**.
- 진짜 과거 전체 학습은 각 직원 PC의 로컬 `~/.orbit/captures/*.png`를 소스로 하는 **로컬 폴더 분석 모드**가 필요 — 원하면 별도 설계.
