# 🧠 Claude Work MindMap

**AI 작업 흐름을 실시간 마인드맵으로 시각화 — Claude Code, Cursor, Windsurf, VS Code 전부 지원**

![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![Tests](https://img.shields.io/badge/tests-130%20passing-brightgreen)
![Version](https://img.shields.io/badge/version-2.0.0-purple)

AI와 대화할 때마다 질문 → 분석 → 작업 → 파일 수정 흐름이 **실시간으로 마인드맵에** 그려집니다.
팀원과 **같은 채널**에 접속하면 서로의 AI 작업을 동시에 볼 수 있습니다.

---

## ✨ 주요 기능

| 기능 | 설명 |
|------|------|
| 🔴 **실시간 마인드맵** | 질문/답변/파일/도구 사용이 노드로 즉시 생성 |
| 👥 **멀티유저 채널** | 팀원이 같은 채널명 입력 → 실시간 공유 |
| 🖥 **멀티터미널 뷰** | 여러 터미널 세션을 한 화면에서 모니터링 |
| 🔒 **보안 유출 감지** | API키·패스워드·JWT 등 12개 패턴 자동 감지 |
| 📊 **코드 분석** | 복잡도·라인수·긴 함수 자동 분석 |
| 🎮 **게임 이펙트** | 작업 중 BLAZING → 완료 시 COOL 애니메이션 |
| 🤖 **멀티 AI 지원** | Claude, Cursor, Windsurf, VS Code, Gemini, GPT |
| 📦 **그룹 클러스터** | 긴 대화를 자동으로 묶어서 표시 |

---

## ⚡ 1분 설치

### macOS / Linux

```bash
# 1. 클론
git clone https://github.com/dlaww-wq/mindmap-viewer.git
cd mindmap-viewer

# 2. 자동 설치 (Node 확인 + npm install + 훅 등록)
bash setup/install.sh

# 3. 서버 시작
bash start.sh
```

### Windows

```powershell
# 1. 클론
git clone https://github.com/dlaww-wq/mindmap-viewer.git
cd mindmap-viewer

# 2. 자동 설치 (cmd 또는 PowerShell에 붙여넣기)
irm https://raw.githubusercontent.com/dlaww-wq/mindmap-viewer/main/setup/install.ps1 | iex

# 3. 서버 시작
start.bat
```

### Docker (팀 서버)

```bash
docker-compose up -d
# → http://localhost:4747
```

---

## 🔌 AI 도구별 연결 방법

### Claude Code ✅ (완전 자동)

`setup/install.sh` 실행 시 자동으로 `~/.claude/settings.json`에 훅 등록됩니다.

수동 설정이 필요하다면:

```bash
# macOS/Linux
cp setup/settings/claude-macos.json ~/.claude/settings.json

# Windows
copy setup\settings\claude-windows.json %APPDATA%\Claude\settings.json
```

### Cursor / Windsurf / Continue.dev

`.cursor/mcp.json` 또는 설정 > 훅(Hook) 메뉴에서 등록:

```json
{
  "onAssistantResponse": "node /path/to/mindmap-viewer/save-turn.js",
  "onUserMessage": "node /path/to/mindmap-viewer/save-turn.js"
}
```

자세한 설정: [`setup/settings/cursor.md`](setup/settings/cursor.md)

### VS Code (GitHub Copilot Chat)

`setup/settings/vscode-extension/` 폴더의 확장 설치 (준비 중)

### Gemini CLI / OpenAI API

어댑터를 통해 직접 연동:

```js
const { normalizeAiEvent } = require('./adapters/ai-adapter-base');

// Gemini 응답 후 호출
const event = normalizeAiEvent({
  aiSource: 'gemini',
  sessionId: 'my-session',
  content: geminiResponse.text,
});
// POST http://localhost:4747/api/hook 으로 전송
```

자세한 예시: [`adapters/`](adapters/) 폴더 참조

---

## 🌐 팀과 함께 쓰기 (채널)

1. **서버 실행자**: `bash start.sh --tunnel` → Cloudflare URL 생성
2. **팀원 전달**: `https://xxxxx.trycloudflare.com`
3. **각자 접속** → 채널 이름 동일하게 입력 (예: `team-alpha`)
4. **Claude Code 환경변수** 설정:

```bash
export MINDMAP_CHANNEL=team-alpha   # 팀 채널 이름
export MINDMAP_MEMBER=다린          # 내 이름
export MINDMAP_PORT=4747            # 서버 포트 (기본값)
```

---

## 🚀 클라우드 배포 (Railway / Render)

### Railway (권장, 무료 플랜 있음)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/dlaww-wq/mindmap-viewer)

또는 수동:
```bash
npm install -g @railway/cli
railway login
railway up
```

### Render

```bash
# render.yaml 이미 포함됨
git push origin main
# → Render 대시보드에서 자동 감지
```

### Docker Compose (자체 서버)

```bash
docker-compose up -d

# 채널별 설정
PORT=4747 docker-compose up -d
```

---

## 📁 프로젝트 구조

```
mindmap-viewer/
├── server.js              # Express + WebSocket 서버
├── save-turn.js           # Claude Code 훅 수신 스크립트
├── event-normalizer.js    # 10가지 훅 이벤트 정규화
├── graph-engine.js        # 마인드맵 그래프 빌더
├── security-scanner.js    # 보안 유출 감지 (12패턴)
├── code-analyzer.js       # 코드 복잡도 분석
├── db.js                  # SQLite CRUD
├── adapters/              # AI별 어댑터
│   ├── ai-adapter-base.js
│   ├── adapter-gemini.js
│   ├── adapter-openai.js
│   └── adapter-vscode.js
├── public/
│   └── index.html         # 마인드맵 UI (vis.js)
├── setup/
│   ├── install.sh         # macOS/Linux 자동 설치
│   ├── install.ps1        # Windows 자동 설치
│   └── settings/          # AI별 설정 파일
├── tests/                 # Jest 테스트 (130개)
├── start.sh               # macOS 서버 시작
└── start.bat              # Windows 서버 시작
```

---

## ⚙️ 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `4747` | 서버 포트 |
| `MINDMAP_PORT` | `4747` | 훅 스크립트가 연결할 서버 포트 |
| `MINDMAP_CHANNEL` | `default` | 채널 ID (팀원 구분) |
| `MINDMAP_MEMBER` | 호스트명 | 마인드맵에 표시될 내 이름 |

---

## 🔒 보안 감지 패턴

AI가 실수로 민감 정보를 다루면 즉시 경보합니다:

| 패턴 | 심각도 |
|------|-------|
| API Key, AWS Key, GitHub Token, Slack Token, SSH/Private Key | 🔴 Critical |
| JWT Token, DB 연결 URL, Password/Secret, Bearer Token | 🟠 High |
| 내부망 IP, 이메일 무더기 | 🟡 Medium |

---

## 📊 비즈니스 모델 로드맵

| 티어 | 대상 | 가격 | 기능 |
|------|------|------|------|
| **Solo Free** | 개인 개발자 | 무료 | 로컬 실행, 단일 사용자 |
| **Team Pro** | 스타트업/팀 | $12/인/월 | 클라우드 호스팅, 채널, 히스토리 |
| **Enterprise** | 기업 | 문의 | SSO, 보안 감사, 온프레미스 |

---

## 🧪 테스트

```bash
npm test          # 130개 테스트 실행
npm test -- --watch   # 파일 변경 감지 모드
```

---

## 📄 라이선스

MIT © 2025
