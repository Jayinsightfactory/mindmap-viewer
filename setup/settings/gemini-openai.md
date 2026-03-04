# Gemini CLI / OpenAI API / 기타 AI 연결 가이드

MindMap 서버는 `POST /api/hook` REST API를 제공합니다.
어떤 AI 도구에서도 HTTP 요청 하나로 연동할 수 있습니다.

---

## Gemini CLI

### 자동 래퍼 스크립트 만들기

```bash
#!/usr/bin/env bash
# gemini-mindmap.sh — Gemini 응답을 MindMap에 전송
# 사용: echo "질문" | bash gemini-mindmap.sh

MINDMAP_URL="${MINDMAP_URL:-http://localhost:4747}"
CHANNEL="${MINDMAP_CHANNEL:-default}"
MEMBER="${MINDMAP_MEMBER:-$(whoami)}"
SESSION="sess_$(date +%s)"

# 사용자 메시지 읽기
USER_MSG=$(cat)

# Gemini 호출 (gemini CLI 필요: pip install google-generativeai)
RESPONSE=$(echo "$USER_MSG" | gemini 2>/dev/null)

# MindMap에 전송
curl -s -X POST "$MINDMAP_URL/api/hook" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg sid "$SESSION" \
    --arg user "$USER_MSG" \
    --arg resp "$RESPONSE" \
    --arg ch "$CHANNEL" \
    --arg mem "$MEMBER" \
    '{
      events: [
        {id: ("ev_u_" + now|tostring), type: "user.message", source: "gemini",
         sessionId: $sid, timestamp: (now|todate),
         data: {content: $user, contentPreview: ($user|.[0:200])}},
        {id: ("ev_a_" + now|tostring), type: "assistant.message", source: "gemini",
         sessionId: $sid, timestamp: (now|todate),
         data: {content: $resp, contentPreview: ($resp|.[0:200]), aiLabel: "Gemini", aiIcon: "🔵"}}
      ],
      channelId: $ch, memberName: $mem
    }')"

echo "$RESPONSE"
```

---

## OpenAI Python SDK

```python
import openai
import requests
import time
import os

client = openai.OpenAI()
MINDMAP_URL = os.getenv("MINDMAP_URL", "http://localhost:4747")
CHANNEL = os.getenv("MINDMAP_CHANNEL", "default")
MEMBER = os.getenv("MINDMAP_MEMBER", "user")

def chat_with_mindmap(user_message: str, session_id: str = None) -> str:
    if not session_id:
        session_id = f"sess_{int(time.time())}"

    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # OpenAI 호출
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": user_message}]
    )
    assistant_message = response.choices[0].message.content

    # MindMap에 전송
    try:
        requests.post(f"{MINDMAP_URL}/api/hook", json={
            "events": [
                {
                    "id": f"ev_u_{int(time.time()*1000)}",
                    "type": "user.message",
                    "source": "openai",
                    "sessionId": session_id,
                    "timestamp": ts,
                    "data": {
                        "content": user_message,
                        "contentPreview": user_message[:200]
                    }
                },
                {
                    "id": f"ev_a_{int(time.time()*1000)+1}",
                    "type": "assistant.message",
                    "source": "openai",
                    "sessionId": session_id,
                    "timestamp": ts,
                    "data": {
                        "content": assistant_message,
                        "contentPreview": assistant_message[:200],
                        "aiLabel": "GPT-4o",
                        "aiIcon": "⚪"
                    }
                }
            ],
            "channelId": CHANNEL,
            "memberName": MEMBER
        }, timeout=2)
    except Exception:
        pass  # MindMap 서버 없어도 계속 동작

    return assistant_message

# 사용 예시
if __name__ == "__main__":
    answer = chat_with_mindmap("Python으로 피보나치 수열 구현해줘")
    print(answer)
```

---

## Node.js / TypeScript 범용 래퍼

```typescript
// mindmap-client.ts
const MINDMAP_URL = process.env.MINDMAP_URL ?? 'http://localhost:4747';
const CHANNEL     = process.env.MINDMAP_CHANNEL ?? 'default';
const MEMBER      = process.env.MINDMAP_MEMBER  ?? 'user';

interface MindmapEvent {
  id: string;
  type: string;
  source: string;
  sessionId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export async function sendToMindmap(events: MindmapEvent[]): Promise<void> {
  try {
    await fetch(`${MINDMAP_URL}/api/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events, channelId: CHANNEL, memberName: MEMBER }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // 서버 없어도 조용히 무시
  }
}

// Anthropic SDK 래퍼 예시
export async function claudeWithMindmap(
  client: any,  // Anthropic client
  userMessage: string,
  sessionId?: string
): Promise<string> {
  const sid = sessionId ?? `sess_${Date.now()}`;
  const ts  = new Date().toISOString();

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 8096,
    messages: [{ role: 'user', content: userMessage }],
  });
  const assistantText = response.content[0].text;

  await sendToMindmap([
    {
      id: `ev_u_${Date.now()}`,
      type: 'user.message', source: 'anthropic-sdk',
      sessionId: sid, timestamp: ts,
      data: { content: userMessage, contentPreview: userMessage.slice(0, 200) },
    },
    {
      id: `ev_a_${Date.now() + 1}`,
      type: 'assistant.message', source: 'anthropic-sdk',
      sessionId: sid, timestamp: ts,
      data: {
        content: assistantText,
        contentPreview: assistantText.slice(0, 200),
        aiLabel: 'Claude', aiIcon: '🟢',
      },
    },
  ]);

  return assistantText;
}
```

---

## 이벤트 타입 목록

| type | 설명 | 마인드맵 색 |
|------|------|------------|
| `user.message` | 사용자 질문 | 🔵 파랑 |
| `assistant.message` | AI 응답 | 🟢 초록 |
| `tool.start` | 도구 시작 | 🟠 주황 (BLAZING) |
| `tool.end` | 도구 완료 | 🟡 노랑 |
| `tool.error` | 도구 오류 | 🔴 빨강 |
| `file.read` | 파일 읽기 | 🟣 보라 |
| `file.write` | 파일 수정 | 🩷 분홍 |
| `session.start` | 세션 시작 | 🟣 보라 |
| `session.end` | 세션 종료 | ⚫ 회색 |
| `subagent.start` | 하위 에이전트 | 🩵 청록 |
