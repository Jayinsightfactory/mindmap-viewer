# Orbit AI — 브레인스토밍 미구현 항목 전체 구현 계획

> 작성일: 2026-02-28
> 기반: research.md 분석 결과
> 목표: 브레인스토밍 17개 섹션 중 미구현 항목 일괄 완성

---

## 접근 방식

research.md에서 확인된 바:
- **OAuth 서버 코드는 이미 완성** → 프론트엔드 UI + 토큰 저장만 추가하면 됨
- **privacy.html 이미 존재** → 링크 연결 + terms.html 신규 생성만 필요
- **Dockerfile 이미 완성** → Docker build 검증만 필요
- **새로 만들 것**: Ollama 어댑터, 포트폴리오 PDF, 모바일 HUD, 접근성 기본 레이어, terms.html

기존 패턴을 **반드시** 유지:
- 라우터: `createRouter(deps)` 팩토리 패턴
- DB 접근: `getDb()` 또는 `db.js` 직접 export 함수 사용
- 인증: `authMiddleware` / `optionalAuth` 재사용
- 환경변수 없으면 폴백 (절대 crash 없이)

---

## 수정/생성될 파일 목록

| # | 파일 | 작업 유형 | 예상 변경량 |
|---|------|-----------|-------------|
| 1 | `public/orbit.html` | 수정 | +50줄 (OAuth 토큰 파싱, 모바일 CSS, 접근성 ARIA, footer, PDF버튼) |
| 2 | `public/settings.html` | 수정 | +120줄 (계정 탭 + 로컬 모델 탭 추가) |
| 3 | `public/terms.html` | 신규 생성 | ~180줄 (privacy.html 구조 재사용) |
| 4 | `src/insight-engine.js` | 수정 | +50줄 (enrichWithOllama + enrichWithLLM 래퍼) |
| 5 | `src/model-trainer.js` | 신규 생성 | ~180줄 (학습 데이터 추출 + ollama create) |
| 6 | `routes/model.js` | 신규 생성 | ~120줄 (모델 관리 API) |
| 7 | `routes/portfolio.js` | 신규 생성 | ~200줄 (PDF 생성 라우터) |
| 8 | `server.js` | 수정 | +10줄 (portfolio + model 라우터 마운트) |
| 9 | `package.json` | 수정 | +1줄 (html-pdf-node 추가) |
| 10 | `.env.example` | 수정 | +4줄 (OLLAMA_URL, OLLAMA_BASE_MODEL, OLLAMA_MODEL, INSIGHT_ENGINE) |
| 11 | `data/training/` | 신규 디렉토리 | 학습 JSONL 파일 저장소 |

---

## 단계별 작업 목록

### Phase 1 — 즉시 완성 (프론트엔드 연결)
> 서버 코드 이미 완성. 프론트만 추가.

- [x] **1-1. orbit.html: OAuth 토큰 수신 처리**
  - `(async () => {` 초기화 블록 직전에 URL 파라미터 파싱 코드 삽입
  - `?oauth_token=XXX&provider=google` → `localStorage.setItem('orbit_token', token)` 저장
  - 저장 후 URL 클린업: `history.replaceState({}, '', '/')`
  - 토큰 있으면 `Authorization: Bearer XXX` 헤더로 `/api/auth/me` 호출 → 사용자 이름 HUD에 표시

- [x] **1-2. settings.html: 계정 탭 추가**
  - 기존 4개 탭(`switchTab()` 구조) 뒤에 `🔑 계정` 탭 추가
  - `tab-account` 컨텐츠 div 추가
  - **미로그인 상태**: Google/GitHub/Kakao 로그인 버튼 표시
    - 버튼 href: `/api/auth/google`, `/api/auth/github`, `/api/auth/kakao`
  - **로그인 상태**: 프로필 카드 + 플랜 뱃지 + 로그아웃 버튼
  - `localStorage.getItem('orbit_token')` 유무로 상태 판단
  - 로그아웃: localStorage 삭제 후 `DELETE /api/auth/logout` 호출

- [x] **1-3. orbit.html: HUD에 사용자 아바타/이름 표시**
  - HUD 우측 끝에 `<div id="user-chip">` 추가
  - 로그인 시: 아바타 이미지 + 이름 표시
  - 미로그인 시: "로그인" 텍스트 → settings.html 링크

- [x] **1-4. orbit.html + settings.html: 법적 링크 footer 추가**
  - orbit.html: `</body>` 직전에 fixed footer 추가 (매우 작게, z-index 낮음)
  - settings.html: 기존 `#main` 아래에 footer 추가
  - 링크: `/privacy.html`, `/terms.html`

### Phase 2 — 법적 문서 완성

- [x] **2-1. terms.html 신규 생성**
  - privacy.html의 CSS/헤더/푸터 구조 그대로 복사
  - 내용: 이용약관 9개 조항 (서비스 정의, 이용조건, 금지행위, 지적재산권, 면책, 개정, 분쟁해결, 준거법, 연락처)
  - footer의 `terms.html` 링크 이미 privacy.html에 있음 → 파일만 생성하면 동작

### Phase 3 — Ollama 커스텀 모델 + 지속 학습 구조

> 핵심 아이디어: Orbit이 축적한 이벤트 데이터로 **나만의 Orbit 전용 모델**을 Ollama에 추가 생성하고,
> 이후 인사이트 분석에 그 모델을 사용하는 구조. 데이터가 쌓일수록 모델도 같이 성장.

#### 아키텍처 개요
```
data/mindmap.db (이벤트 누적)
        ↓ [학습 데이터 추출: POST /api/model/export-training]
data/training/ (JSONL 학습 데이터 파일)
        ↓ [Modelfile 자동 생성 + ollama create 실행]
Ollama 로컬 모델 레지스트리 (orbit-insight:latest)
        ↓ [인사이트 엔진이 이 모델 사용]
insight-engine.js → enrichWithOllama() → /api/generate
```

#### 학습 데이터 구조 (`data/training/orbit-YYYYMMDD.jsonl`)
```jsonl
{"prompt":"세션 데이터: {이벤트 타입, 파일, 시간대, 에러율}","response":"인사이트: 야간 에러율 높음, 리팩토링 필요"}
{"prompt":"파일 수정 패턴: server.js 12회, auth.js 8회","response":"인사이트: 인증 모듈 집중 수정, 보안 감사 권장"}
```

- [x] **3-1. `src/model-trainer.js` 신규 생성**
  - **역할**: DB 이벤트 → 학습 JSONL 변환 + Modelfile 생성 + `ollama create` 실행
  - **주요 함수**:
    - `exportTrainingData(getAllEvents)` → `data/training/orbit-{날짜}.jsonl` 저장
      - 이벤트 패턴 → prompt/response 쌍 자동 생성 (규칙 기반)
      - 기존 insight-engine의 `analyzeEvents()` 결과를 ground-truth response로 활용
    - `buildModelfile(baseModel, trainingFile)` → `data/Modelfile` 생성
      - `FROM llama3.2` (기본) 또는 `OLLAMA_BASE_MODEL` 환경변수
      - `SYSTEM "당신은 Orbit AI 개발 인사이트 전문가입니다..."`
      - `ADAPTER {trainingFile}` (LoRA 방식, Ollama 0.3+ 지원)
    - `trainModel()` → `ollama create orbit-insight -f data/Modelfile` 실행 (child_process)
    - `listAvailableModels()` → `ollama list` 파싱 → `orbit-*` 모델 목록 반환
    - `getActiveModel()` → `data/model-config.json`에서 현재 사용 모델 읽기
    - `setActiveModel(modelName)` → `data/model-config.json` 업데이트

- [x] **3-2. `routes/model.js` 신규 생성**
  - `createRouter(deps)` 팩토리 패턴
  - deps: `{ getAllEvents, modelTrainer, authMiddleware, broadcastAll }`
  - 엔드포인트:
    - `GET  /api/model/status`         — 현재 활성 모델 + ollama 연결 상태
    - `GET  /api/model/list`           — 사용 가능한 orbit-* 모델 목록
    - `POST /api/model/train`          — 학습 데이터 추출 + 모델 생성 (비동기)
    - `POST /api/model/activate`       — `{ modelName }` → 활성 모델 변경
    - `GET  /api/model/training-data`  — 생성된 학습 데이터 미리보기
    - `DELETE /api/model/:name`        — 모델 삭제 (`ollama rm`)
  - 학습 진행상황 WebSocket 브로드캐스트: `broadcastAll({ type: 'model_training', progress })`

- [x] **3-3. `src/insight-engine.js`: enrichWithLLM 래퍼 추가**
  - `enrichWithClaude()` 아래에 `enrichWithOllama()` 추가
    - `OLLAMA_URL` (기본: `http://localhost:11434`)
    - 활성 모델: `modelTrainer.getActiveModel()` → 없으면 `OLLAMA_MODEL` env → 없으면 `llama3.2`
    - `AbortSignal.timeout(15000)` — 타임아웃 폴백
  - `runOnce()` 내 `enrichWithClaude()` → `enrichWithLLM()` 래퍼로 교체:
    ```javascript
    async function enrichWithLLM(ruleInsights, stats) {
      if (process.env.INSIGHT_ENGINE === 'ollama') return enrichWithOllama(ruleInsights, stats);
      if (process.env.ANTHROPIC_API_KEY)           return enrichWithClaude(ruleInsights, stats);
      return ruleInsights;
    }
    ```
  - `module.exports`에 변경 없음 (기존 인터페이스 유지)

- [x] **3-4. `server.js`: model 라우터 마운트**
  - 기존 라우터 블록 뒤에 추가 (5줄)

- [x] **3-5. `public/settings.html`: AI 모델 관리 탭 추가**
  - 기존 탭 뒤에 `🤖 로컬 모델` 탭 신규 추가
  - 내용:
    - **현재 활성 모델 카드** (모델명, 학습 날짜, 이벤트 수)
    - **모델 목록** (orbit-insight:v1, orbit-insight:v2... — 라디오 선택)
    - **학습 시작 버튼** → `POST /api/model/train` → 진행률 표시
    - **Ollama 연결 상태** 표시 (`GET /api/model/status`)
    - **학습 데이터 미리보기** (최근 5개 prompt/response 쌍)

- [x] **3-6. `.env.example` 업데이트**
  - 추가: `OLLAMA_URL`, `OLLAMA_BASE_MODEL`, `OLLAMA_MODEL`, `INSIGHT_ENGINE`

#### 학습 데이터 자동 생성 로직 (model-trainer.js 핵심)
```javascript
// 이벤트 DB → prompt/response 학습 쌍 자동 생성
// 기존 insight-engine.analyzeEvents() 결과를 ground-truth로 사용
function generateTrainingPairs(events) {
  const pairs = [];
  // 세션별 요약 → 인사이트 쌍
  for (const session of groupBySession(events)) {
    const prompt   = summarizeSession(session);   // 이벤트 통계 요약
    const response = analyzeEvents(session).map(i => i.title + ': ' + i.body).join('\n');
    if (response) pairs.push({ prompt, response });
  }
  // 파일 수정 패턴 → 인사이트 쌍
  // 시간대 패턴 → 인사이트 쌍
  // 에러율 패턴 → 인사이트 쌍
  return pairs; // JSONL로 저장
}
```

### Phase 4 — AI 역량 포트폴리오 PDF

- [x] **4-1. package.json: html-pdf-node 추가** *(선택 설치 — npm install html-pdf-node)*
  - `"html-pdf-node": "^1.0.8"` — puppeteer-core 기반 래퍼, 가장 단순
  - `npm install html-pdf-node` 실행 필요

- [x] **4-2. routes/portfolio.js 신규 생성**
  - `createRouter(deps)` 팩토리 패턴 사용
  - deps: `{ getAllEvents, getSessions, getStats, getFiles, optionalAuth }`
  - 엔드포인트:
    - `GET /api/portfolio/preview` — HTML 미리보기 (브라우저 확인용)
    - `GET /api/portfolio/pdf` — PDF 다운로드 (`Content-Disposition: attachment`)
  - PDF 내용 (HTML 템플릿 인라인):
    - 헤더: Orbit AI 로고 + 생성 날짜
    - 섹션 1: 프로젝트 요약 (총 이벤트, 세션, 파일, 기간)
    - 섹션 2: AI 도구 사용 프로필 (aiSource별 비율 바 차트 → SVG)
    - 섹션 3: 생산성 패턴 (일별 활동, 피크 시간)
    - 섹션 4: 주요 작업 파일 Top 10
    - 섹션 5: 인사이트 엔진 결과 (최근 5개)
    - 푸터: Orbit AI 서명 + 날짜

- [x] **4-3. server.js: portfolio 라우터 마운트**
  - 기존 라우터 등록 블록 뒤에 추가:
    ```javascript
    const createPortfolioRouter = require('./routes/portfolio');
    app.use('/api', createPortfolioRouter({ getAllEvents, getSessions, getStats, getFiles, optionalAuth }));
    ```

- [x] **4-4. orbit.html HUD: 포트폴리오 버튼 추가**
  - 기존 HUD 버튼 목록에 추가:
    ```html
    <a href="/api/portfolio/pdf" target="_blank"><button class="hud-btn"
      data-tip-title="📄 포트폴리오 PDF"
      data-tip-desc="AI 역량 리포트를 PDF로 내보냅니다.">📄 PDF</button></a>
    ```

### Phase 5 — 모바일 반응형 HUD

- [x] **5-1. orbit.html: 모바일 CSS 미디어 쿼리 추가**
  - `<style>` 블록 끝에 추가:
  ```css
  @media (max-width: 768px) {
    #hud {
      height: auto; flex-wrap: wrap; padding: 6px 8px; gap: 6px;
    }
    .hud-btn { font-size: 10px; padding: 4px 7px; }
    #density-slider { width: 50px; }
    #insight-panel { width: calc(100vw - 32px); }
    #zoomout-hud { top: auto; bottom: 80px; flex-wrap: wrap; }
    .zoh-card { min-width: 70px; }
  }
  @media (max-width: 480px) {
    .hud-btn.hud-secondary { display: none; }
  }
  ```
  - 비필수 버튼에 `class="hud-btn hud-secondary"` 추가 (팀, 커뮤니티, 솔루션)

### Phase 6 — 접근성 기본 레이어 (A11y)

- [x] **6-1. orbit.html: ARIA 기본 속성 추가**
  - `#three-container`에 `role="application" aria-label="Orbit AI 뉴런 맵"` 추가
  - `#hud`에 `role="toolbar" aria-label="Orbit 제어 도구"` 추가
  - `initHudTooltips()` 내부에서 data-tip-title → aria-label 자동 설정 1줄 추가
  - `aria-live="polite"` 히든 리전 추가 (이벤트 카운트 알림용)

- [x] **6-2. orbit.html: prefers-reduced-motion CSS**
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
  ```
  - JS 초기화 시 `matchMedia('(prefers-reduced-motion: reduce)').matches` 체크
  - 해당 시 `orbitEnabled = false` 기본값 강제

---

## 핵심 코드 스니펫

### [1-1] OAuth 토큰 수신 (orbit.html 초기화 직전)
```javascript
(function handleOAuthCallback() {
  const params = new URLSearchParams(location.search);
  const token  = params.get('oauth_token');
  if (token) {
    localStorage.setItem('orbit_token', token);
    history.replaceState({}, '', location.pathname);
  }
})();

async function loadCurrentUser() {
  const token = localStorage.getItem('orbit_token');
  if (!token) return null;
  try {
    const res = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) { localStorage.removeItem('orbit_token'); return null; }
    return await res.json();
  } catch { return null; }
}
```

### [3-1] model-trainer.js 핵심 구조
```javascript
// src/model-trainer.js
const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const DATA_DIR     = path.join(__dirname, '..', 'data');
const TRAINING_DIR = path.join(DATA_DIR, 'training');
const CONFIG_FILE  = path.join(DATA_DIR, 'model-config.json');

// 활성 모델 조회 (data/model-config.json → env → 기본값)
function getActiveModel() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return cfg.activeModel || process.env.OLLAMA_MODEL || 'llama3.2';
  } catch {
    return process.env.OLLAMA_MODEL || 'llama3.2';
  }
}

// 활성 모델 변경 (영구 저장)
function setActiveModel(modelName) {
  const cfg = fs.existsSync(CONFIG_FILE)
    ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  cfg.activeModel = modelName;
  cfg.updatedAt   = new Date().toISOString();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// DB 이벤트 → JSONL 학습 쌍 생성
function exportTrainingData(events) {
  if (!fs.existsSync(TRAINING_DIR)) fs.mkdirSync(TRAINING_DIR, { recursive: true });
  const pairs    = generateTrainingPairs(events);
  const date     = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filePath = path.join(TRAINING_DIR, `orbit-${date}.jsonl`);
  fs.writeFileSync(filePath, pairs.map(p => JSON.stringify(p)).join('\n'), 'utf8');
  return { filePath, count: pairs.length };
}

// Modelfile 생성 후 ollama create 실행
async function trainModel(events, onProgress) {
  const { filePath, count } = exportTrainingData(events);
  onProgress?.({ step: 'data_exported', count });

  const baseModel  = process.env.OLLAMA_BASE_MODEL || 'llama3.2';
  const modelName  = `orbit-insight:v${Date.now()}`;
  const modelfile  = path.join(DATA_DIR, 'Modelfile');

  fs.writeFileSync(modelfile, [
    `FROM ${baseModel}`,
    `SYSTEM """당신은 Orbit AI 개발 인사이트 전문가입니다.`,
    `개발자의 AI 도구 사용 패턴을 분석하고 실용적인 조언을 제공합니다.`,
    `항상 JSON 배열 형식으로 인사이트를 반환하세요."""`,
    // Ollama 0.3+ LoRA 어댑터 (데이터 있을 때)
    count > 10 ? `ADAPTER ${filePath}` : '',
  ].filter(Boolean).join('\n'), 'utf8');
  onProgress?.({ step: 'modelfile_created', modelName });

  // ollama create 비동기 실행
  return new Promise((resolve, reject) => {
    const proc = spawn('ollama', ['create', modelName, '-f', modelfile]);
    proc.stdout.on('data', d => onProgress?.({ step: 'training', log: d.toString() }));
    proc.on('close', code => {
      if (code === 0) { setActiveModel(modelName); resolve({ modelName }); }
      else reject(new Error(`ollama create failed (exit ${code})`));
    });
  });
}

// ollama list → orbit-* 모델만 필터
function listAvailableModels() {
  try {
    const out = execSync('ollama list', { encoding: 'utf8', timeout: 5000 });
    return out.split('\n').slice(1)
      .map(l => l.trim().split(/\s+/)[0])
      .filter(n => n && n.startsWith('orbit-'));
  } catch { return []; }
}
```

### [3-2] enrichWithOllama (insight-engine.js)
```javascript
// model-trainer 없이도 독립 동작 (getActiveModel 인라인)
async function enrichWithOllama(ruleInsights, stats) {
  const baseUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  let   model;
  try {
    const cfg = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, '..', 'data', 'model-config.json'), 'utf8'));
    model = cfg.activeModel;
  } catch {}
  model = model || process.env.OLLAMA_MODEL || 'llama3.2';

  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false,
        prompt: `개발 데이터: ${JSON.stringify(stats)}\n인사이트 2개 JSON: [{"title":"...","body":"...","type":"ollama_insight","confidence":0.7}]`
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data  = await res.json();
    const match = (data.response || '').match(/\[[\s\S]*\]/);
    if (match) return [...ruleInsights, ...JSON.parse(match[0])];
  } catch (err) { console.warn('[insight-engine] Ollama 폴백:', err.message); }
  return ruleInsights;
}
```

### [4-2] 포트폴리오 라우터 핵심 구조
```javascript
// routes/portfolio.js
function createRouter({ getAllEvents, getSessions, getStats, getFiles, optionalAuth }) {
  const router = express.Router();

  router.get('/portfolio/preview', optionalAuth, (req, res) => {
    const html = buildPortfolioHtml(getAllEvents(), getSessions(), getStats(), getFiles());
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  router.get('/portfolio/pdf', optionalAuth, async (req, res) => {
    const htmlPdf = require('html-pdf-node');
    const html    = buildPortfolioHtml(getAllEvents(), getSessions(), getStats(), getFiles());
    const buffer  = await htmlPdf.generatePdf(
      { content: html },
      { format: 'A4', printBackground: true,
        margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' } }
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="orbit-portfolio-${Date.now()}.pdf"`);
    res.send(buffer);
  });

  return router;
}
```

---

## 트레이드오프 및 고려 사항

| 항목 | 선택 | 이유 |
|------|------|------|
| PDF 라이브러리 | html-pdf-node | puppeteer full은 ~200MB, wkhtmltopdf는 Alpine 설치 복잡 |
| Ollama 학습 방식 | LoRA 어댑터 (Ollama 0.3+) | FROM 베이스모델 + ADAPTER 학습데이터 → 경량 파인튜닝 |
| Ollama 기본 베이스 모델 | llama3.2 (env로 교체 가능) | 경량, 한국어 지원, 로컬 실행 빠름 |
| 모델 버전 관리 | `orbit-insight:v{timestamp}` | 매 학습마다 새 태그 생성, 롤백 가능 |
| 학습 ground-truth | 기존 analyzeEvents() 결과 재사용 | 새 라벨링 불필요, 즉시 시작 가능 |
| OAuth 토큰 전달 방식 | URL 파라미터 유지 | 이미 server 코드가 이렇게 설계됨. history.replaceState로 즉시 클린 |
| 모바일 버튼 숨김 | 480px 이하 secondary 숨김 | HUD 과밀 방지. 링크로 대체 접근 가능 |
| A11y 수준 | ARIA 기본 + reduced-motion | Three.js 캔버스 완전 키보드 내비는 대규모 작업. 최소 레이어만 |

---

## 건드리면 안 되는 것

| 항목 | 이유 |
|------|------|
| `src/db.js` export 인터페이스 | 11개 라우터가 직접 의존 |
| `src/auth.js` `authMiddleware` / `optionalAuth` 시그니처 | 모든 라우터 재사용 |
| `/api/auth/{provider}/callback` URL 구조 | 외부 OAuth 콘솔에 등록된 URL |
| `orbit.html` Three.js importmap `three@0.160.1` | 버전 고정, CSS2DRenderer 호환 |
| `broadcastAll` / `broadcastToChannel` 시그니처 | server.js 주입, 전체 의존 |
| `insight-engine.js` `module.exports` 구조 | `{ start, stop, runOnce, getInsights, analyzeEvents }` |
| `market-store.js` `initMarketTables()` 호출 순서 | initDatabase() 이후만 가능 |
| PORT=4747 | 사용자 환경에서 이미 사용 중 |

---

## 구현 순서 (의존성 기준)

```
Phase 1 (독립)     Phase 2 (독립)    Phase 3 (독립)
OAuth 토큰 처리  →  terms.html    →  Ollama 어댑터
계정 탭
HUD 사용자칩
footer 링크
        ↓
Phase 4 (npm install 먼저)
html-pdf-node 설치
portfolio.js 생성
server.js 마운트
HUD PDF 버튼
        ↓
Phase 5 + 6 (orbit.html 수정, 독립)
모바일 CSS
ARIA + reduced-motion
```
