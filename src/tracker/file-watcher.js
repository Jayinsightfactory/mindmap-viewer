/**
 * src/tracker/file-watcher.js
 * ─────────────────────────────────────────────────────────────────
 * 파일 변경 감시 및 메타데이터 수집
 *
 * 기능:
 *   - chokidar를 사용한 실시간 파일 감시
 *   - Before/After 메타데이터 비교
 *   - 매일 00:00 UTC 수집 데이터 준비
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { extractFileMetadata, formatFileRecord, getFileHash } = require('./file-metadata');
const { categorizeProgram } = require('./categories');

class FileWatcher {
  constructor(options = {}) {
    this.watchPaths = options.watchPaths || this._getDefaultWatchPaths();
    this.fileStates = new Map();           // 파일 경로 → 메타데이터
    this.dailyChanges = [];                // 일일 변경 목록
    this.watcher = null;
    this.isInitialized = false;
    this.lastActiveApp = '';               // 마지막 활동 앱
    this.onFileChange = options.onFileChange || (() => {});
  }

  /**
   * 기본 감시 경로
   * @private
   */
  _getDefaultWatchPaths() {
    const homeDir = require('os').homedir();
    return [
      path.join(homeDir, 'Documents'),
      path.join(homeDir, 'Desktop'),
      path.join(homeDir, 'Downloads'),
      // 사용자 설정 경로는 config에서 추가 가능
    ];
  }

  /**
   * 감시 시작
   * @returns {Promise<void>}
   */
  async init() {
    if (this.isInitialized) return;

    console.log('[file-watcher] 초기화 중...', this.watchPaths);

    // 기존 파일 상태 로드
    await this._loadFileStates();

    // chokidar 감시 시작
    this.watcher = chokidar.watch(this.watchPaths, {
      ignored: /(^|[/\\])\./, // 숨김 파일 제외
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
      usePolling: false,
      useFsEvents: true,
    });

    this.watcher
      .on('add', (filePath) => this._onFileAdd(filePath))
      .on('change', (filePath) => this._onFileChange(filePath))
      .on('unlink', (filePath) => this._onFileDelete(filePath))
      .on('error', (err) => console.error('[file-watcher] Error:', err));

    this.isInitialized = true;
    console.log('[file-watcher] 감시 시작됨');
  }

  /**
   * 파일 추가 이벤트
   * @private
   */
  async _onFileAdd(filePath) {
    try {
      const metadata = await extractFileMetadata(filePath);
      this.fileStates.set(filePath, metadata);

      const record = formatFileRecord(filePath, {}, metadata, this.lastActiveApp);
      this.dailyChanges.push(record);

      this.onFileChange({ type: 'add', record });
      console.log(`[file-watcher] 파일 생성: ${filePath}`);
    } catch (e) {
      console.error(`[file-watcher] Error adding file ${filePath}:`, e.message);
    }
  }

  /**
   * 파일 변경 이벤트
   * @private
   */
  async _onFileChange(filePath) {
    try {
      const before = this.fileStates.get(filePath) || {};
      const after = await extractFileMetadata(filePath);

      // 유의미한 변경인지 확인 (크기 또는 라인수 변경)
      const sizeChanged = (before.size || 0) !== (after.size || 0);
      const linesChanged = (before.lineCount || 0) !== (after.lineCount || 0);

      if (sizeChanged || linesChanged) {
        this.fileStates.set(filePath, after);

        const record = formatFileRecord(filePath, before, after, this.lastActiveApp);
        this.dailyChanges.push(record);

        this.onFileChange({ type: 'modify', record });
        console.log(`[file-watcher] 파일 수정: ${filePath}`);
      }
    } catch (e) {
      console.error(`[file-watcher] Error changing file ${filePath}:`, e.message);
    }
  }

  /**
   * 파일 삭제 이벤트
   * @private
   */
  async _onFileDelete(filePath) {
    try {
      const before = this.fileStates.get(filePath) || {};
      this.fileStates.delete(filePath);

      const record = formatFileRecord(filePath, before, {}, this.lastActiveApp);
      this.dailyChanges.push(record);

      this.onFileChange({ type: 'delete', record });
      console.log(`[file-watcher] 파일 삭제: ${filePath}`);
    } catch (e) {
      console.error(`[file-watcher] Error deleting file ${filePath}:`, e.message);
    }
  }

  /**
   * 기존 파일 상태 로드
   * @private
   */
  async _loadFileStates() {
    const stateFile = path.join(require('os').homedir(), '.orbit-file-states.json');

    if (fs.existsSync(stateFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        this.fileStates = new Map(Object.entries(data));
        console.log(`[file-watcher] 기존 상태 로드: ${this.fileStates.size} 파일`);
      } catch (e) {
        console.warn('[file-watcher] 상태 파일 로드 실패:', e.message);
      }
    }
  }

  /**
   * 파일 상태 저장
   * @private
   */
  async _saveFileStates() {
    const stateFile = path.join(require('os').homedir(), '.orbit-file-states.json');
    const data = Object.fromEntries(this.fileStates);
    fs.writeFileSync(stateFile, JSON.stringify(data, null, 2));
  }

  /**
   * 현재 활성 앱 설정
   * @param {string} appName - 애플리케이션명
   */
  setActiveApp(appName) {
    this.lastActiveApp = appName;
  }

  /**
   * 일일 변경 목록 조회
   * @returns {Object[]}
   */
  getDailyChanges() {
    return this.dailyChanges;
  }

  /**
   * 일일 요약 생성
   * @returns {Object}
   */
  generateDailySummary() {
    const summary = {
      date: new Date().toISOString().split('T')[0],
      totalFiles: this.fileStates.size,
      todayChanges: this.dailyChanges.length,
      byCategory: {},
      byChangeType: {
        created: 0,
        modified: 0,
        deleted: 0,
      },
    };

    // 카테고리별 통계
    this.dailyChanges.forEach((change) => {
      const cat = change.category;
      summary.byCategory[cat] = (summary.byCategory[cat] || 0) + 1;
      summary.byChangeType[change.change.type] = (summary.byChangeType[change.change.type] || 0) + 1;
    });

    return summary;
  }

  /**
   * 일일 데이터 초기화 (다음날 준비)
   */
  resetDailyData() {
    this._saveFileStates();  // 현재 상태 저장
    this.dailyChanges = [];  // 일일 목록 초기화
    console.log('[file-watcher] 일일 데이터 초기화됨');
  }

  /**
   * 감시 중지
   * @returns {Promise<void>}
   */
  async close() {
    if (this.watcher) {
      await this.watcher.close();
      await this._saveFileStates();
      this.isInitialized = false;
      console.log('[file-watcher] 감시 종료됨');
    }
  }

  /**
   * 수동 동기화 (특정 파일 강제 검사)
   * @param {string[]} filePaths - 파일 경로 배열
   * @returns {Promise<Object[]>}
   */
  async manualSync(filePaths = []) {
    const results = [];

    for (const filePath of filePaths) {
      if (!fs.existsSync(filePath)) {
        // 파일이 없음 → 삭제된 경우
        const before = this.fileStates.get(filePath) || {};
        this.fileStates.delete(filePath);
        const record = formatFileRecord(filePath, before, {}, this.lastActiveApp);
        results.push(record);
      } else {
        // 파일 존재
        const before = this.fileStates.get(filePath) || {};
        const after = await extractFileMetadata(filePath);
        this.fileStates.set(filePath, after);
        const record = formatFileRecord(filePath, before, after, this.lastActiveApp);
        results.push(record);
      }
    }

    this.dailyChanges.push(...results);
    return results;
  }

  /**
   * 현재 상태 조회
   * @returns {Object}
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      watchPaths: this.watchPaths,
      trackedFiles: this.fileStates.size,
      dailyChanges: this.dailyChanges.length,
      lastActiveApp: this.lastActiveApp,
    };
  }
}

module.exports = FileWatcher;
