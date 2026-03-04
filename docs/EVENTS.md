# Event Types — Orbit AI

Orbit이 추적하고 처리하는 모든 이벤트 타입과 각 타입의 `data` 필드를 정의합니다.

---

## 이벤트 기본 구조

모든 이벤트는 다음 공통 필드를 가집니다:

```json
{
  "id":            "string",   // 이벤트 고유 ID
  "type":          "string",   // 이벤트 타입 (아래 목록)
  "source":        "string",   // 발생 소스 (claude-code, cursor, ai-adapter 등)
  "sessionId":     "string",   // 세션 ID
  "parentEventId": "string",   // 부모 이벤트 ID (null 가능)
  "channelId":     "string",   // 채널 ID
  "userId":        "string",   // 사용자 ID
  "timestamp":     "string",   // ISO 8601 타임스탬프
  "data":          "object",   // 이벤트별 상세 데이터 (아래 참고)
  "metadata":      "object"    // 추가 메타데이터 (aiSource, model 등)
}
```

---

## Claude Code 이벤트 타입

### `user.message`
사용자가 Claude에게 메시지를 전송했습니다.

```json
{
  "data": {
    "content": "string",   // 메시지 내용
    "tokens":  "number"    // 토큰 수 (옵션)
  }
}
```

### `tool.start`
Claude가 도구 실행을 시작했습니다.

```json
{
  "data": {
    "toolName": "string",  // 도구 이름 (Read, Write, Bash, Edit 등)
    "input":    "object",  // 도구 입력 파라미터
    "file":     "string"   // 관련 파일 경로 (옵션)
  }
}
```

### `tool.end`
도구 실행이 완료되었습니다.

```json
{
  "data": {
    "toolName": "string",  // 도구 이름
    "duration": "number",  // 실행 시간 (ms)
    "output":   "string"   // 실행 결과 요약 (옵션)
  }
}
```

### `tool.error`
도구 실행 중 오류가 발생했습니다.

```json
{
  "data": {
    "toolName": "string",  // 도구 이름
    "error":    "string",  // 오류 메시지
    "stack":    "string"   // 스택 트레이스 (옵션)
  }
}
```

### `assistant.response`
Claude가 응답을 생성했습니다.

```json
{
  "data": {
    "content": "string",   // 응답 내용 요약
    "tokens":  "number"    // 출력 토큰 수 (옵션)
  }
}
```

### `file.write`
파일이 생성되거나 수정되었습니다.

```json
{
  "data": {
    "path":    "string",   // 파일 절대 경로
    "action":  "string",   // "create" | "update" | "delete"
    "size":    "number"    // 파일 크기 (bytes, 옵션)
  }
}
```

### `session.start`
새 작업 세션이 시작되었습니다.

```json
{
  "data": {
    "memberName": "string",  // 작업자 이름
    "projectDir": "string"   // 프로젝트 디렉토리 (옵션)
  }
}
```

### `session.end`
작업 세션이 종료되었습니다.

```json
{
  "data": {
    "duration":   "number",  // 세션 지속 시간 (ms)
    "eventCount": "number"   // 세션 내 이벤트 수
  }
}
```

---

## 주석 이벤트

### `annotation`
사용자가 노드에 주석을 추가했습니다.

```json
{
  "data": {
    "linkedEventId": "string",  // 연결된 이벤트 ID (null 가능)
    "label":         "string",  // 라벨 텍스트
    "description":   "string",  // 상세 설명
    "color":         "string",  // HEX 색상 (#f0c674 등)
    "icon":          "string"   // 아이콘 문자 (옵션)
  }
}
```

---

## 외부 AI 어댑터 이벤트

Gemini, OpenAI, Perplexity 등 외부 AI 어댑터에서 전송하는 이벤트.
`source` 필드에 AI 소스가 기록되며, `metadata.aiSource` 에도 저장됩니다.

### `ai.message`
외부 AI에게 메시지를 전송했습니다.

```json
{
  "data": {
    "aiLabel":  "string",  // AI 표시 이름 ("Gemini", "GPT-4o" 등)
    "model":    "string",  // 모델 ID
    "content":  "string",  // 메시지 내용
    "tokens":   "number"   // 토큰 수 (옵션)
  },
  "metadata": {
    "aiSource": "string",  // AI 소스 ID (ai-adapter-base.js 의 AI_SOURCES 값)
    "aiLabel":  "string",
    "model":    "string"
  }
}
```

### `ai.response`
외부 AI가 응답했습니다.

```json
{
  "data": {
    "aiLabel":  "string",
    "model":    "string",
    "content":  "string",
    "latency":  "number"   // 응답 시간 (ms, 옵션)
  }
}
```

---

## Zoom / Calendar 이벤트

외부 협업 도구 통합 이벤트.

### `zoom.meeting`
Zoom 회의 관련 이벤트.

```json
{
  "data": {
    "participant": "string",  // 참여자 이름 (/api/members 에서 사용)
    "topic":       "string",  // 회의 주제
    "action":      "string"   // "join" | "leave" | "start" | "end"
  }
}
```

### `calendar.event`
캘린더 이벤트.

```json
{
  "data": {
    "title":     "string",    // 이벤트 제목
    "attendees": [            // 참석자 목록 (/api/members 에서 사용)
      { "name": "string", "email": "string" }
    ],
    "startTime": "string",    // ISO 8601
    "endTime":   "string"
  }
}
```

---

## 이벤트 → 노드 매핑

그래프 엔진(`src/graph-engine.js`)은 이벤트 타입을 다음과 같이 노드로 변환합니다:

| 이벤트 타입 | 노드 형태 | 기본 색상 |
|-------------|-----------|-----------|
| `user.message` | 원형 | `#58a6ff` |
| `tool.start` | 육각형 | `#3fb950` |
| `tool.end` | 육각형 (완료) | `#3fb950` |
| `tool.error` | 육각형 (오류) | `#f85149` |
| `assistant.response` | 다이아몬드 | `#bc8cff` |
| `file.write` | 사각형 | `#ffa657` |
| `annotation` | 별 | `#f0c674` |
| `session.start` | 타원 (큰) | `#39d2c0` |
| AI 어댑터 이벤트 | 다이아몬드 | AI 소스별 색상 |

---

## 목적(Purpose) 분류

`src/purpose-classifier.js` 가 이벤트 시퀀스를 분석해 작업 목적을 자동 분류합니다:

| 목적 ID | 설명 | 색상 |
|---------|------|------|
| `implement` | 새 기능 구현 | `#3fb950` |
| `fix` | 버그 수정 | `#f85149` |
| `refactor` | 코드 리팩토링 | `#bc8cff` |
| `test` | 테스트 작성/실행 | `#ffa657` |
| `docs` | 문서화 | `#58a6ff` |
| `analyze` | 코드 분석/리뷰 | `#39d2c0` |
| `config` | 설정 변경 | `#f778ba` |
| `research` | 리서치/탐색 | `#ff9500` |
| `deploy` | 배포 관련 | `#8957e5` |
