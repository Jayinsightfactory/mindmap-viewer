# Chrome Web Store Listing

## Basic Info
- **Title**: Orbit — AI 대화 수집기
- **Short Description** (45 chars max): AI 대화를 자동 수집하고 3D 마인드맵으로 시각화
- **Category**: Productivity
- **Language**: Korean (한국어)

## Full Description

Orbit는 여러 AI 플랫폼의 대화를 자동으로 수집하여 3D 마인드맵으로 시각화하는 도구입니다.

### 지원 플랫폼
- ChatGPT (chat.openai.com, chatgpt.com)
- Claude (claude.ai)
- Gemini (gemini.google.com)
- Perplexity (perplexity.ai)
- Bing Chat / Copilot (bing.com, copilot.microsoft.com)

### 핵심 기능
- **자동 대화 수집**: AI와의 대화가 자동으로 캡처되어 Orbit 서버에 저장됩니다.
- **3D 시각화**: 수집된 대화를 Three.js 기반 3D 우주 뷰로 탐색할 수 있습니다.
- **세션 기반 정리**: 각 대화 세션이 독립 행성 노드로 표시되며, 하위 이벤트는 위성으로 배치됩니다.
- **멀티 AI 통합**: ChatGPT, Claude, Gemini 등 여러 AI의 대화를 하나의 타임라인에서 확인할 수 있습니다.
- **로컬 우선 저장**: 데이터는 로컬 서버 또는 사용자 지정 클라우드에 저장됩니다. 제3자 서버에 원본 대화가 전송되지 않습니다.

### 사용 방법
1. Orbit 서버를 로컬 또는 클라우드에 설치합니다.
2. 확장 프로그램 팝업에서 서버 URL을 설정합니다.
3. 지원되는 AI 사이트에서 대화하면 자동으로 수집됩니다.
4. Orbit 대시보드에서 3D 마인드맵으로 작업 흐름을 확인합니다.

### 개인정보 보호
- 대화 데이터는 사용자가 설정한 서버에만 전송됩니다.
- 제3자 분석 도구나 광고 네트워크를 사용하지 않습니다.
- 수집 범위는 사용자가 직접 제어할 수 있습니다.

### 오픈소스
이 프로젝트는 MIT 라이선스로 공개되어 있습니다.
GitHub: https://github.com/dlaww-wq/mindmap-viewer

## Screenshots Needed
1. **팝업 UI**: 확장 프로그램 팝업 화면 (서버 연결 상태, 수집 현황)
2. **3D 대시보드**: Orbit 3D 마인드맵 전체 뷰 (행성 노드들이 보이는 화면)
3. **노드 상세**: 특정 세션 노드를 클릭했을 때 상세 카드 화면
4. **멀티 AI**: ChatGPT + Claude 대화가 동시에 수집된 타임라인 화면
5. **설정 화면**: 서버 URL 설정 및 수집 옵션 화면

## Privacy Practices Disclosure
- **Single Purpose**: AI 대화 수집 및 시각화
- **Data Collection**:
  - AI 대화 텍스트 (사용자가 방문하는 AI 사이트에서만)
  - 세션 메타데이터 (시간, AI 플랫폼명)
- **Data Usage**: 사용자 지정 서버로 전송하여 시각화 목적으로만 사용
- **Data Sharing**: 제3자와 공유하지 않음
- **Data Storage**: 사용자가 지정한 서버 (로컬 또는 클라우드)
- **Remote Code**: 사용하지 않음
- **Permissions Justification**:
  - `tabs`: 현재 탭의 AI 플랫폼 감지
  - `storage`: 확장 프로그램 설정 로컬 저장
  - `alarms`: 주기적 데이터 동기화 스케줄링
  - `scripting`: AI 사이트에서 대화 내용 추출
  - `host_permissions`: 지원되는 AI 사이트 접근 및 Orbit 서버 통신
