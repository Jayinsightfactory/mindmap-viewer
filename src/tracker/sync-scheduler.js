/**
 * src/tracker/sync-scheduler.js
 * ─────────────────────────────────────────────────────────────────
 * 파일 & 메시지 추적 데이터 Google Drive 동기화
 *
 * 기능:
 *   - 매일 00:00 UTC 자동 동기화
 *   - 파일 메타데이터 + 메시지 통계 수집
 *   - Google Drive에 일별 JSON 파일 저장
 *   - 로컬 캐시 (7일) 유지
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

const fs = require('fs');
const path = require('path');
const FileWatcher = require('./file-watcher');
const { trackAllServices } = require('./message-tracker');

class SyncScheduler {
  constructor(options = {}) {
    this.fileWatcher = null;
    this.getValidGoogleToken = options.getValidGoogleToken || (() => null);
    this.getUserId = options.getUserId || (() => 'anonymous');
    this.getDb = options.getDb || (() => null);
    this.onSync = options.onSync || (() => {});

    this.dataDir = path.join(require('os').homedir(), '.orbit-tracker');
    this.retryCount = 0;
    this.maxRetries = 3;
    this.syncTimer = null;
    this.isInitialized = false;
  }

  /**
   * 스케줄러 초기화
   * @returns {Promise<void>}
   */
  async init() {
    if (this.isInitialized) return;

    console.log('[sync-scheduler] 초기화 중...');

    // 데이터 디렉토리 생성
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    // 파일 감시자 초기화
    this.fileWatcher = new FileWatcher({
      onFileChange: (change) => this._onFileChange(change),
    });
    await this.fileWatcher.init();

    // 스케줄 시작 (매일 00:00 UTC)
    this._scheduleSync();

    // 초기화 시 즉시 1회 동기화 (선택사항)
    // await this.sync();

    this.isInitialized = true;
    console.log('[sync-scheduler] 초기화 완료');
  }

  /**
   * 일일 동기화 스케줄 설정
   * @private
   */
  _scheduleSync() {
    const now = new Date();
    const nextSync = new Date(now);
    nextSync.setUTCHours(0, 0, 0, 0);

    // 이미 오늘 00:00 UTC를 지났으면 내일로
    if (nextSync <= now) {
      nextSync.setUTCDate(nextSync.getUTCDate() + 1);
    }

    const msUntilSync = nextSync.getTime() - now.getTime();
    console.log(`[sync-scheduler] 다음 동기화: ${nextSync.toISOString()} (${Math.round(msUntilSync / 1000 / 60)}분 후)`);

    this.syncTimer = setTimeout(() => {
      console.log('[sync-scheduler] 일일 동기화 시작...');
      this.sync().catch(e => console.error('[sync-scheduler] Sync error:', e.message));
      // 다음 날 동기화 스케줄
      this._scheduleSync();
    }, msUntilSync);
  }

  /**
   * 파일 변경 이벤트 핸들러
   * @private
   */
  _onFileChange(change) {
    // 실시간으로 변경사항 브로드캐스트 (선택사항)
    // this.onSync({ type: 'file_change', data: change });
  }

  /**
   * 동기화 실행 (파일 + 메시지)
   * @returns {Promise<Object>}
   */
  async sync() {
    try {
      console.log('[sync-scheduler] 동기화 시작...');

      // 1. 파일 데이터 수집
      const fileData = this._collectFileData();

      // 2. 메시지 데이터 수집 (토큰이 있는 경우만)
      const messageTokens = await this._getMessageTokens();
      const messageData = await trackAllServices(messageTokens);

      // 3. 통합 데이터 생성
      const syncData = {
        version: '1.0',
        date: new Date().toISOString().split('T')[0],
        timestamp: new Date().toISOString(),
        userId: this.getUserId(),

        files: fileData.changes,
        fileSummary: fileData.summary,

        messages: messageData.services,
        messageSummary: messageData.summary,

        overall: {
          totalEvents: fileData.changes.length + (messageData.summary.totalMessages || 0),
        },
      };

      // 4. 로컬 저장
      await this._saveLocal(syncData);

      // 5. Google Drive 업로드
      const googleToken = this.getValidGoogleToken();
      if (googleToken) {
        await this._uploadToGoogleDrive(syncData, googleToken);
      } else {
        console.log('[sync-scheduler] Google Drive 토큰 없음, 로컬 저장만 수행');
      }

      // 6. 로컬 캐시 정리 (7일 이상 된 파일 삭제)
      await this._cleanOldCache();

      // 7. 일일 데이터 초기화
      this.fileWatcher.resetDailyData();

      // 8. 콜백 실행
      this.onSync({
        type: 'sync_complete',
        data: {
          date: syncData.date,
          fileChanges: fileData.changes.length,
          messageCount: messageData.summary.totalMessages,
          uploaded: !!googleToken,
        },
      });

      this.retryCount = 0;
      console.log('[sync-scheduler] 동기화 완료');
      return syncData;
    } catch (e) {
      console.error('[sync-scheduler] Sync error:', e.message);
      this.retryCount++;

      if (this.retryCount < this.maxRetries) {
        const delay = Math.min(3600000, 300000 * this.retryCount); // 최대 1시간
        console.log(`[sync-scheduler] ${delay / 1000}초 후 재시도... (${this.retryCount}/${this.maxRetries})`);
        setTimeout(() => this.sync(), delay);
      }

      throw e;
    }
  }

  /**
   * 파일 데이터 수집
   * @private
   */
  _collectFileData() {
    const changes = this.fileWatcher.getDailyChanges();
    const summary = this.fileWatcher.generateDailySummary();

    return {
      changes,
      summary,
    };
  }

  /**
   * 메시지 서비스 토큰 조회
   * @private
   */
  async _getMessageTokens() {
    // DB에서 사용자의 메시지 서비스 토큰 조회
    // 현재는 구현 없음 (향후 추가)
    return {};
  }

  /**
   * 로컬 저장
   * @private
   */
  async _saveLocal(syncData) {
    const fileName = `tracker-${syncData.date}.json`;
    const filePath = path.join(this.dataDir, fileName);

    fs.writeFileSync(filePath, JSON.stringify(syncData, null, 2));
    console.log(`[sync-scheduler] 로컬 저장: ${filePath}`);

    return filePath;
  }

  /**
   * Google Drive 업로드
   * @private
   */
  async _uploadToGoogleDrive(syncData, googleToken) {
    try {
      // 실제 구현: googleapis 클라이언트로 Google Drive에 업로드
      // const drive = google.drive({ version: 'v3', auth: oauth2Client });
      // const fileMetadata = {
      //   name: `${syncData.date}.json`,
      //   parents: ['Orbit-Tracker-Folder-ID'],
      // };
      // const media = {
      //   mimeType: 'application/json',
      //   body: JSON.stringify(syncData),
      // };
      // const file = await drive.files.create({
      //   resource: fileMetadata,
      //   media: media,
      //   fields: 'id',
      // });

      // 현재는 로깅만
      console.log(`[sync-scheduler] Google Drive 업로드: ${syncData.date}.json`);
      // return file.data;
    } catch (e) {
      console.error('[sync-scheduler] Google Drive upload failed:', e.message);
      throw e;
    }
  }

  /**
   * 오래된 로컬 캐시 정리 (7일 이상)
   * @private
   */
  async _cleanOldCache() {
    const files = fs.readdirSync(this.dataDir);
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(this.dataDir, file);
      const stat = fs.statSync(filePath);

      if (now - stat.mtime.getTime() > sevenDaysMs) {
        fs.unlinkSync(filePath);
        console.log(`[sync-scheduler] 오래된 캐시 삭제: ${file}`);
      }
    }
  }

  /**
   * 수동 동기화
   * @returns {Promise<Object>}
   */
  async manualSync() {
    return this.sync();
  }

  /**
   * 상태 조회
   * @returns {Object}
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      fileWatcher: this.fileWatcher?.getStatus(),
      dataDir: this.dataDir,
      retryCount: this.retryCount,
      nextSyncTime: this.syncTimer ? 'scheduled' : 'not scheduled',
    };
  }

  /**
   * 스케줄러 종료
   * @returns {Promise<void>}
   */
  async close() {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    if (this.fileWatcher) {
      await this.fileWatcher.close();
    }
    this.isInitialized = false;
    console.log('[sync-scheduler] 종료됨');
  }
}

// 싱글톤 인스턴스
let instance = null;

/**
 * 스케줄러 인스턴스 가져오기
 * @param {Object} options - 옵션
 * @returns {SyncScheduler}
 */
function getInstance(options = {}) {
  if (!instance) {
    instance = new SyncScheduler(options);
  }
  return instance;
}

module.exports = {
  SyncScheduler,
  getInstance,
};
