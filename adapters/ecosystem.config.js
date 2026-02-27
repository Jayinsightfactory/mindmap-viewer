/**
 * PM2 ecosystem 설정
 * 모든 어댑터를 한번에 실행
 *
 * 설치: npm install -g pm2
 * 실행: pm2 start adapters/ecosystem.config.js
 * 상태: pm2 status
 * 로그: pm2 logs
 * 종료: pm2 stop all
 */
module.exports = {
  apps: [
    // ── Orbit 메인 서버 ──────────────────────────
    {
      name:   'orbit-server',
      script: 'server.js',
      cwd:    require('path').resolve(__dirname, '..'),
      env: {
        PORT:          4747,
        NODE_ENV:      'production',
        MINDMAP_MEMBER: process.env.MINDMAP_MEMBER || 'local',
      },
    },

    // ── Notion 어댑터 (폴링) ─────────────────────
    {
      name:   'orbit-notion',
      script: 'adapters/notion-adapter.js',
      cwd:    require('path').resolve(__dirname, '..'),
      env: {
        NOTION_API_KEY:       process.env.NOTION_API_KEY      || '',
        NOTION_DATABASE_IDS:  process.env.NOTION_DATABASE_IDS || '',
        NOTION_POLL_INTERVAL: '60',
        MINDMAP_CHANNEL:      process.env.MINDMAP_CHANNEL     || 'default',
        MINDMAP_PORT:         '4747',
      },
    },

    // ── Google Calendar 어댑터 (폴링) ────────────
    {
      name:   'orbit-calendar',
      script: 'adapters/calendar-adapter.js',
      cwd:    require('path').resolve(__dirname, '..'),
      env: {
        GOOGLE_CLIENT_ID:      process.env.GOOGLE_CLIENT_ID     || '',
        GOOGLE_CLIENT_SECRET:  process.env.GOOGLE_CLIENT_SECRET || '',
        CALENDAR_IDS:          process.env.CALENDAR_IDS         || 'primary',
        CALENDAR_DAYS_AHEAD:   '7',
        MINDMAP_CHANNEL:       process.env.MINDMAP_CHANNEL      || 'default',
        MINDMAP_PORT:          '4747',
      },
    },

    // ── Slack + Discord 웹훅 서버 ────────────────
    {
      name:   'orbit-slack',
      script: 'adapters/slack-adapter.js',
      cwd:    require('path').resolve(__dirname, '..'),
      env: {
        SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET || '',
        SLACK_BOT_TOKEN:      process.env.SLACK_BOT_TOKEN      || '',
        MINDMAP_CHANNEL:      process.env.MINDMAP_CHANNEL      || 'default',
        MINDMAP_PORT:         '4747',
        WEBHOOK_PORT:         '4748',
      },
    },

    // ── Zoom 웹훅 서버 ───────────────────────────
    {
      name:   'orbit-zoom',
      script: 'adapters/zoom-adapter.js',
      cwd:    require('path').resolve(__dirname, '..'),
      env: {
        ZOOM_WEBHOOK_SECRET:  process.env.ZOOM_WEBHOOK_SECRET  || '',
        ZOOM_ACCOUNT_ID:      process.env.ZOOM_ACCOUNT_ID      || '',
        ZOOM_CLIENT_ID:       process.env.ZOOM_CLIENT_ID       || '',
        ZOOM_CLIENT_SECRET:   process.env.ZOOM_CLIENT_SECRET   || '',
        MINDMAP_CHANNEL:      process.env.MINDMAP_CHANNEL      || 'default',
        MINDMAP_PORT:         '4747',
        WEBHOOK_PORT:         '4749',
      },
    },

    // ── 일상 업무 추적 어댑터 (문서/브라우저/ERP) ─
    {
      name:   'orbit-daily',
      script: 'adapters/daily-work-adapter.js',
      cwd:    require('path').resolve(__dirname, '..'),
      env: {
        MINDMAP_CHANNEL:    process.env.MINDMAP_CHANNEL   || 'daily',
        MINDMAP_MEMBER:     process.env.MINDMAP_MEMBER    || require('os').userInfo().username,
        MINDMAP_PORT:       '4747',
        BROWSER_PORT:       '4750',
        KAKAOTALK_TOKEN:    process.env.KAKAOTALK_TOKEN   || '',
        WATCH_DIRS:         process.env.WATCH_DIRS        || '',
        WATCH_EXTENSIONS:   process.env.WATCH_EXTENSIONS  || '',
        ERP_WATCH_DIR:      process.env.ERP_WATCH_DIR     || '',
      },
    },
  ],
};
