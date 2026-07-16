# 비전 분석 전용 PC 세팅 지침 (백로그·상시 학습용)

> 목적: 화면 캡처 Vision 분석을 **두 번째 PC**에서 돌려 처리량을 늘리고, 소유자 PC 워커와 분리한다.
> 근거: `bin/vision-worker.js` (server-queue 모드) · `DATA_CHECK.md` · `no-reboot-use-selfheal`.

## 0. 모델 결정 — Sonnet vs Haiku

**결론: Sonnet.** (자세한 이유는 맨 아래 "모델 근거")
- 이 작업 = **한글 ERP/카톡/엑셀 화면을 읽어 거래처·품목·작업절차·automationScore를 구조화 추출**.
- 이건 밀도 높은 화면 이해 + 구조 추출이라 **Haiku는 얕게 뽑아** 그동안의 커버리지 문제(2.1%·액션 0)를 그대로 답습.
- 전용 PC를 구독(Max/Pro)으로 돌리면 **토큰당 비용 0** → 비용 때문에 Haiku로 낮출 이유 없음.
- **Haiku는** 순수 물량 소진 + 속도/비용이 절대 제약일 때만. "제대로 학습"이 목표면 아님.

## 1. 그 PC에 필요한 것

- Windows 10/11 또는 macOS
- **Node.js** (18+) — `node -v`로 확인
- **git**
- **인증 둘 중 하나:**
  - (권장) **Claude CLI 로그인** — Max/Pro 구독. 토큰당 비용 0.
  - (대안) **ANTHROPIC_API_KEY** — 종량 과금(Sonnet). 백로그가 크면 비용 주의.
- ⚠️ **소유자 PC와 다른 Claude 계정 또는 API 키를 쓸 것.** 같은 Max 계정을 두 PC가 쓰면 **사용량 한도(quota)를 공유**해 서로 굶는다.

## 2. 설치 (한 번)

```powershell
# 1) 저장소 클론
git clone https://github.com/Jayinsightfactory/mindmap-viewer.git
cd mindmap-viewer

# 2) 의존성 (워커는 대부분 내장모듈 + src/quota-guard만 필요하나 안전하게)
npm install

# 3) Claude CLI 설치·로그인 (Max/Pro 구독 경로 — 무과금)
#    설치: https://claude.ai/download 또는 npm i -g @anthropic-ai/claude-code
claude   # 최초 실행 시 로그인(구독 계정). 'where claude'로 경로 확인되면 워커가 자동 감지.

# 4) 서버 인증 설정 파일 — %USERPROFILE%\.orbit-config.json 생성
#    token = orbit_ 프리픽스 마스터 분석토큰(소유자에게 받기), serverUrl 고정
```

`%USERPROFILE%\.orbit-config.json` 내용:
```json
{
  "token": "orbit_여기에_분석토큰",
  "serverUrl": "https://mindmap-viewer-production-adb2.up.railway.app"
}
```

## 3. 실행

```powershell
cd C:\...\mindmap-viewer

# 무과금(CLI) + Sonnet 강제 + 즉시분석(백로그 소진)
$env:ANTHROPIC_API_KEY = ''            # 비워야 CLI 무과금 경로
$env:VISION_CLI_MODEL   = 'sonnet'     # 모델 지정(권장). 미설정 시 계정 기본
$env:ORBIT_CLI_RESERVE_PCT = '10'      # 전용 PC라 사용자 몫 최소만 보전(백로그 빨리)
node bin/vision-worker.js --server-queue --flush
```

API 키 방식으로 할 경우:
```powershell
$env:ANTHROPIC_API_KEY = 'sk-ant-...'
$env:VISION_API_MODEL  = 'claude-sonnet-4-20250514'   # 기본이 이미 Sonnet
node bin/vision-worker.js --server-queue --flush
```

- `--server-queue`: 서버 큐(`/api/vision/queue`)에서 이미지 가져와 분석.
- `--flush`: 주간에도 즉시 분석(야간 대기 안 함).
- 폴링 기본 10분. 더 자주: `$env:VISION_POLL_MS='120000'` (2분), 배치: `$env:VISION_BATCH_N='40'`.

## 4. 상시 백그라운드 (선택 — 소유자 PC와 동일 패턴)

`~/.orbit/vision-worker-start.ps1` 만들고(소유자 PC 파일 참고), `HKCU\...\Run`에 hidden.vbs 등록.
간단히는 작업 스케줄러에 "로그인 시 위 명령 실행"로 등록.

## 5. 검증 (숫자로)

```
BASE = https://mindmap-viewer-production-adb2.up.railway.app  (Authorization: Bearer <토큰>)
- GET /api/vision/stat            → worker.running / processed 증가?
- GET /api/learning/capture-funnel?days=1 → analyzed 수 상승?
- 로컬 로그 ~/.orbit/vision-worker.log → "처리 N건" 라인 (UTF-16 인코딩 주의)
```
- `[quota]` 라인이 계속 뜨면: 그 계정 사용량 한도 도달 → 다른 계정/키 필요하거나 `ORBIT_CLI_RESERVE_PCT` 조정.

## ⚠️ 중요 — "백로그 전부"의 현실

- 서버 큐는 **인메모리·사용자당 6장 상한**(OOM 방지). 즉 **분석 안 되고 지나간 옛 캡처는 큐에서 이미 버려졌다** — 서버엔 없다.
- 따라서 두 번째 PC가 늘리는 건 주로 **지금부터의 실시간 스트림 처리량/깊이**(더 좋은 모델로).
- **진짜 과거 전체**를 학습하려면: 각 직원 PC의 로컬 `~/.orbit/captures/*.png`(원본 저장분)를 소스로 삼아야 함 — 이건 별도 파이프라인(로컬 폴더 분석 모드). 필요하면 따로 설계.

## 모델 근거 (요약)

| | Sonnet | Haiku |
|---|---|---|
| 한글 화면 OCR·밀집 UI 이해 | 강 | 약 |
| 거래처/품목/작업절차 **구조 추출** | 강 (커버리지↑) | 약 (얕음) |
| 속도·비용 | 보통 | 빠름·쌈 |
| 구독(CLI) 시 토큰비용 | 0 | 0 |

→ 이번 프로젝트의 핵심 병목이 **추출 품질(커버리지)**이므로 **Sonnet**. Haiku는 "많이 빨리"가 목표일 때만.
