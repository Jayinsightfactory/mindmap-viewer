/**
 * webhook-server.js
 * Slack + Discord + Zoom 웹훅을 하나의 서버로 통합
 *
 * 실행: node adapters/webhook-server.js
 * 포트: WEBHOOK_PORT (기본 4748)
 *
 * 필요 환경변수:
 *   SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN
 *   ZOOM_WEBHOOK_SECRET, ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET
 *   DISCORD_WEBHOOK_SECRET
 *   MINDMAP_CHANNEL, MINDMAP_PORT
 *   WEBHOOK_PORT
 *
 * ngrok으로 외부 노출:
 *   ngrok http 4748
 *   → Slack:   https://xxx.ngrok.io/api/webhooks/slack
 *   → Discord: https://xxx.ngrok.io/api/webhooks/discord
 *   → Zoom:    https://xxx.ngrok.io/api/webhooks/zoom
 */
const { app: zoomApp } = require('./zoom-adapter');
const slackApp = require('./slack-adapter');

// slack-adapter.js는 자체 app.listen을 포함하므로
// webhook-server.js는 zoom 라우트를 슬랙 앱에 마운트하는 방식
// 또는 아래처럼 독립 실행으로 사용

console.log('[Webhook Server] Slack/Discord/Zoom 어댑터를 각각 실행하세요:');
console.log('  node adapters/slack-adapter.js   (Slack + Discord)');
console.log('  node adapters/zoom-adapter.js    (Zoom)');
console.log('  node adapters/notion-adapter.js  (Notion)');
console.log('  node adapters/calendar-adapter.js (Google Calendar)');
console.log('');
console.log('또는 PM2로 한번에:');
console.log('  pm2 start adapters/ecosystem.config.js');
