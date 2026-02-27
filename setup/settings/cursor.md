# Cursor / Windsurf / Continue.dev 연결 가이드

## 방법 1: 규칙 파일로 자동 연동 (권장)

Cursor는 `.cursor/rules` 또는 `.cursorrules` 파일로 명령을 실행할 수 있습니다.

### `.cursor/rules` 생성

프로젝트 루트에 `.cursor/rules` 파일 생성:

```
After every assistant response, run:
  node /absolute/path/to/mindmap-viewer/save-turn.js
```

---

## 방법 2: MCP 서버로 연동

`~/.cursor/mcp.json` 파일에 추가:

```json
{
  "mcpServers": {
    "mindmap": {
      "command": "node",
      "args": ["/absolute/path/to/mindmap-viewer/mcp-server.js"],
      "env": {
        "MINDMAP_CHANNEL": "my-team",
        "MINDMAP_MEMBER": "내이름"
      }
    }
  }
}
```

---

## 방법 3: 쉘 래퍼로 수동 연동

AI 응답 후 터미널에서 직접 실행:

```bash
# ~/.zshrc 또는 ~/.bashrc에 추가
alias mm-sync="node /path/to/mindmap-viewer/save-turn.js"

# 사용: AI 대화 후
mm-sync <<< '{"hook_event_name":"Stop","session_id":"manual"}'
```

---

## 방법 4: REST API 직접 호출 (모든 AI 도구 가능)

MindMap 서버가 실행 중이면 어떤 도구에서도 HTTP POST로 이벤트 전송:

```bash
curl -X POST http://localhost:4747/api/hook \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "id": "ev_001",
      "type": "assistant.message",
      "source": "cursor",
      "sessionId": "sess_001",
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
      "data": {
        "content": "AI 응답 내용",
        "contentPreview": "AI 응답 내용"
      }
    }],
    "channelId": "my-team",
    "memberName": "내이름"
  }'
```

---

## Windsurf

Windsurf는 Cursor와 동일한 방식으로 `.windsurfrules` 파일 지원:

```
# .windsurfrules
After every response, notify MindMap:
  node /path/to/mindmap-viewer/save-turn.js
```

---

## Continue.dev

`~/.continue/config.json`에 추가:

```json
{
  "customCommands": [
    {
      "name": "sync-mindmap",
      "prompt": "{{{ input }}}",
      "description": "MindMap과 동기화",
      "afterCommand": "node /path/to/mindmap-viewer/save-turn.js"
    }
  ]
}
```
