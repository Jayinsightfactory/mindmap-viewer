const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    process.env.NODE_ENV === 'production'
      ? winston.format.json()
      : winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
            return `${timestamp} ${level}: ${message}${metaStr}`;
          })
        )
  ),
  transports: [
    new winston.transports.Console(),
  ],
  // 프로덕션에서 에러 로그 파일 추가 (Railway에서는 stdout만 사용하므로 비활성)
  // new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
});

// 기존 console.log 호환을 위한 child loggers
logger.db = logger.child({ service: 'db' });
logger.ws = logger.child({ service: 'ws' });
logger.hook = logger.child({ service: 'hook' });
logger.auth = logger.child({ service: 'auth' });
logger.api = logger.child({ service: 'api' });

module.exports = logger;
