/**
 * src/tracker/file-metadata.js
 * ─────────────────────────────────────────────────────────────────
 * 파일 메타데이터 추출 및 Before/After 비교
 *
 * 기능:
 *   - 파일 크기, 수정시간, 라인수 등 메타데이터 추출
 *   - Before/After 상태 비교
 *   - 파일 내용은 저장하지 않음 (메타데이터만)
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { categorizeProgram, getFileCategoryByExtension } = require('./categories');

/**
 * 파일 메타데이터 추출 (내용 제외)
 * @param {string} filePath - 파일 경로
 * @returns {Promise<Object>} 메타데이터
 */
async function extractFileMetadata(filePath) {
  try {
    // 기본 파일 정보
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const { category } = getFileCategoryByExtension(filePath);

    // 파일 통계
    const stats = fs.statSync(filePath);
    const size = stats.size;
    const mtime = stats.mtime.toISOString();

    // 라인 수 계산 (텍스트 파일만)
    let lineCount = 0;
    let isText = true;
    try {
      if (size > 10 * 1024 * 1024) {
        // 10MB 이상은 스킵
        isText = false;
      } else if (ext.match(/\.(js|ts|py|java|cpp|c|go|rs|php|rb|jsx|tsx|json|yaml|yml|xml|html|css|md|txt|log|conf|ini)$/i)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        lineCount = content.split('\n').length;
      } else {
        isText = false;
      }
    } catch (e) {
      // 바이너리 파일 또는 읽기 실패
      isText = false;
    }

    // 특수 메타데이터 (파일 타입별)
    const metadata = {
      size,
      mtime,
      lineCount: isText ? lineCount : 0,
      isText,
    };

    // Excel/Sheets: 시트 수 (간단한 방식)
    if (ext.match(/\.(xlsx?|ods|csv)$/i)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const sheetCount = (content.match(/\[/g) || []).length;  // 대략적 추정
        metadata.sheets = Math.max(1, Math.floor(sheetCount / 100));  // 추정값
      } catch (e) {
        metadata.sheets = 1;
      }
    }

    return metadata;
  } catch (e) {
    console.error(`[file-metadata] Error extracting metadata for ${filePath}:`, e.message);
    return {
      size: 0,
      mtime: new Date().toISOString(),
      lineCount: 0,
      isText: false,
      error: e.message,
    };
  }
}

/**
 * 파일 상태 비교
 * @param {Object} before - 이전 메타데이터
 * @param {Object} after - 현재 메타데이터
 * @returns {Object} 변경사항
 */
function compareMetadata(before, after) {
  const changes = {
    type: 'unknown',
    sizeChange: 0,
    sizePercent: 0,
    linesChange: 0,
    sheetsChange: 0,
    modified: false,
  };

  if (!before || Object.keys(before).length === 0) {
    changes.type = 'created';
    changes.sizeChange = after.size || 0;
    changes.linesChange = after.lineCount || 0;
    changes.modified = true;
  } else if (!after || Object.keys(after).length === 0) {
    changes.type = 'deleted';
    changes.sizeChange = -(before.size || 0);
    changes.linesChange = -(before.lineCount || 0);
    changes.modified = true;
  } else {
    changes.type = 'modified';
    changes.sizeChange = (after.size || 0) - (before.size || 0);
    changes.sizePercent = before.size ? Math.round((changes.sizeChange / before.size) * 100) : 0;
    changes.linesChange = (after.lineCount || 0) - (before.lineCount || 0);
    changes.sheetsChange = (after.sheets || 0) - (before.sheets || 0);
    changes.modified = changes.sizeChange !== 0 || changes.linesChange !== 0;
  }

  return changes;
}

/**
 * 저장용 파일 기록 생성
 * @param {string} filePath - 파일 경로
 * @param {Object} before - 이전 메타데이터
 * @param {Object} after - 현재 메타데이터
 * @param {string} appName - 애플리케이션명 (선택)
 * @returns {Object} 저장용 기록
 */
function formatFileRecord(filePath, before, after, appName) {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const { category, program } = getFileCategoryByExtension(filePath);
  const appCategory = appName ? categorizeProgram(appName) : { category, program };

  const change = compareMetadata(before, after);

  return {
    path: filePath,
    name: fileName,
    ext,
    category: appCategory.category,
    program: appCategory.program,
    before: before || {},
    after: after || {},
    change,
    timestamp: new Date().toISOString(),
  };
}

/**
 * 로컬 파일 해시 계산 (변경 감지용)
 * @param {string} filePath - 파일 경로
 * @returns {Promise<string>} SHA-256 해시
 */
async function getFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * 배치 메타데이터 추출
 * @param {string[]} filePaths - 파일 경로 배열
 * @returns {Promise<Object>} { filePath: metadata, ... }
 */
async function extractBatchMetadata(filePaths) {
  const results = {};
  for (const filePath of filePaths) {
    try {
      results[filePath] = await extractFileMetadata(filePath);
    } catch (e) {
      results[filePath] = { error: e.message };
    }
  }
  return results;
}

module.exports = {
  extractFileMetadata,
  compareMetadata,
  formatFileRecord,
  getFileHash,
  extractBatchMetadata,
};
