'use strict';
/**
 * vision-analyzer.js
 * Screenshot → Claude Vision API → activity description
 *
 * Uses Anthropic API (Claude) to analyze screenshots and describe what the user is doing.
 * Results are sent to the server as events.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

// Read API key from orbit config or env
function getApiKey() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8'));
    return config.anthropicKey || config.claudeApiKey || process.env.ANTHROPIC_API_KEY || '';
  } catch { return process.env.ANTHROPIC_API_KEY || ''; }
}

/**
 * Analyze a screenshot file using Claude Vision API
 * @param {string} imagePath - path to PNG file
 * @returns {Promise<{description: string, activity: string, app: string, confidence: number}>}
 */
async function analyzeScreenshot(imagePath) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('[vision-analyzer] API 키 없음 — ~/.orbit-config.json에 anthropicKey 설정 필요');
    return null;
  }

  const imageData = fs.readFileSync(imagePath);
  const base64 = imageData.toString('base64');
  const mediaType = 'image/png';

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 }
        },
        {
          type: 'text',
          text: '이 스크린샷에서 사용자가 무엇을 하고 있는지 한국어로 간단히 설명해주세요. JSON으로 답변: {"activity": "작업 유형 (코딩/문서작성/웹검색/디자인/커뮤니케이션/기타)", "app": "사용 중인 앱 이름", "description": "구체적으로 무엇을 하고 있는지 1줄", "confidence": 0.0~1.0}'
        }
      ]
    }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) { console.warn('[vision-analyzer]', parsed.error.message); resolve(null); return; }
          const text = parsed.content?.[0]?.text || '';
          // Extract JSON from response
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            resolve(JSON.parse(jsonMatch[0]));
          } else {
            resolve({ description: text.slice(0, 100), activity: 'unknown', app: 'unknown', confidence: 0.3 });
          }
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', e => { console.warn('[vision-analyzer]', e.message); resolve(null); });
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

module.exports = { analyzeScreenshot, getApiKey };
