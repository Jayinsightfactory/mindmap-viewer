# Orbit Agent SDK

어떤 봇/스크립트든 Orbit 맵에 실시간으로 이벤트를 리포트합니다.

## 설치

```bash
# 현재: 로컬 경로로 사용
const orbit = require('./sdk/orbit-agent');

# 미래 (npm 배포 후)
npm install orbit-agent-sdk
```

## 빠른 시작

```js
const { createAgent } = require('./sdk/orbit-agent');

const agent = createAgent({
  name:    'my-scraper',   // 맵에 표시될 이름
  source:  'custom',       // AI 소스 식별자
  channel: 'team-alpha',   // 같은 채널 = 실시간 공유
  host:    'localhost',
  port:    4747,
});

// 작업 시작/완료
await agent.start('fetchData');
const data = await fetch('https://api.example.com/data');
await agent.done('fetchData');

// 또는 wrap으로 자동 처리
const result = await agent.wrap('fetchData', async () => {
  return fetch('https://api.example.com/data');
});

// 파일 작업 기록
await agent.readFile('/path/to/file.json');
await agent.writeFile('/path/to/output.json');

// 메시지 전송
await agent.message('데이터 수집 완료: 1,234건');
```

## 글로벌 싱글톤

```js
const { init, getAgent } = require('./sdk/orbit-agent');

// 앱 시작 시 한 번만 초기화
init({ name: 'n8n-worker', source: 'n8n', channel: 'production' });

// 어디서든 사용
const agent = getAgent();
await agent.event('tool.end', { toolName: 'HTTP Request', success: true });
```

## 이벤트 타입

| 타입 | 설명 |
|------|------|
| `tool.start` | 도구 실행 시작 |
| `tool.end` | 도구 실행 완료/실패 |
| `assistant.message` | 봇 메시지 출력 |
| `file.read` | 파일 읽기 |
| `file.write` | 파일 쓰기 |
| `session.end` | 세션 종료 |
| (임의 문자열) | 커스텀 이벤트 |

## n8n 연동 예시

n8n의 "Code" 노드에서:
```js
const { createAgent } = require('/path/to/sdk/orbit-agent');
const agent = createAgent({ name: 'n8n', source: 'n8n', channel: 'default' });

await agent.wrap('Process Items', async () => {
  // n8n 작업 로직
  return $input.all().map(item => item.json);
});

return items;
```

## Moltbot 연동 예시

```js
const orbit = require('./sdk/orbit-agent').init({
  name: 'moltbot', source: 'moltbot', channel: 'ops'
});

moltbot.on('task:start', async (task) => {
  await orbit.start(task.name, { taskId: task.id });
});
moltbot.on('task:done', async (task) => {
  await orbit.done(task.name, { duration: task.duration });
});
```
