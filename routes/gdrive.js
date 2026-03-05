'use strict';
/**
 * routes/gdrive.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 사용자별 Google Drive 백업 / 복원 / 동기화 API
 *
 * 엔드포인트:
 *   POST /api/gdrive/backup       — 즉시 백업 실행
 *   GET  /api/gdrive/backups      — 백업 목록 조회
 *   GET  /api/gdrive/status       — Drive 연결 상태
 *   GET  /api/gdrive/sync-check   — 다른 PC 백업 확인 (F3용)
 *   POST /api/gdrive/import       — 백업 가져오기 (F3용)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

function createGdriveRouter({ verifyToken, auth, dbModule, gdriveUserBackup }) {
  const router = express.Router();

  function getUserFromReq(req) {
    if (process.env.AUTH_DISABLED === '1') return { id: 'local' };
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
                || req.query.token;
    return verifyToken ? verifyToken(token) : null;
  }

  // POST /api/gdrive/backup — 즉시 백업
  router.post('/gdrive/backup', async (req, res) => {
    try {
      const user = getUserFromReq(req);
      if (!user || user.id === 'local') return res.status(401).json({ error: 'login required' });

      const accessToken = await auth.getValidGoogleToken(user.id);
      if (!accessToken) return res.status(400).json({ error: 'Google Drive 연결이 필요합니다. Google로 다시 로그인해주세요.' });

      const result = await gdriveUserBackup.backupUserDataToDrive(user.id, accessToken, dbModule);
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[gdrive/backup]', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/gdrive/backups — 백업 목록
  router.get('/gdrive/backups', async (req, res) => {
    try {
      const user = getUserFromReq(req);
      if (!user || user.id === 'local') return res.status(401).json({ error: 'login required' });

      const accessToken = await auth.getValidGoogleToken(user.id);
      if (!accessToken) return res.json({ backups: [], connected: false });

      const backups = await gdriveUserBackup.listBackups(accessToken);
      res.json({ ok: true, backups, connected: true });
    } catch (e) {
      res.json({ ok: false, backups: [], error: e.message });
    }
  });

  // GET /api/gdrive/status — Drive 연결 상태
  router.get('/gdrive/status', async (req, res) => {
    try {
      const user = getUserFromReq(req);
      if (!user || user.id === 'local') return res.json({ connected: false });

      const tokens = auth.getOAuthTokens(user.id);
      if (!tokens?.refreshToken) return res.json({ connected: false });

      const accessToken = await auth.getValidGoogleToken(user.id);
      res.json({
        connected: !!accessToken,
        hasRefreshToken: !!tokens.refreshToken,
        provider: 'google',
      });
    } catch (e) {
      res.json({ connected: false, error: e.message });
    }
  });

  // GET /api/gdrive/sync-check — 다른 PC 백업 확인 (F3)
  router.get('/gdrive/sync-check', async (req, res) => {
    try {
      const user = getUserFromReq(req);
      if (!user || user.id === 'local') return res.json({ hasBackup: false });

      const accessToken = await auth.getValidGoogleToken(user.id);
      if (!accessToken) return res.json({ hasBackup: false });

      const backups = await gdriveUserBackup.listBackups(accessToken);
      if (backups.length === 0) return res.json({ hasBackup: false });

      const currentPcId = gdriveUserBackup.getPcId();
      const latest = backups[0];
      const samePC = latest.pcId === currentPcId;

      res.json({
        hasBackup: true,
        samePC,
        currentPcId,
        latestBackup: {
          fileId: latest.fileId,
          fileName: latest.fileName,
          pcId: latest.pcId,
          createdAt: latest.createdAt,
          size: latest.size,
        },
        backupCount: backups.length,
      });
    } catch (e) {
      res.json({ hasBackup: false, error: e.message });
    }
  });

  // POST /api/gdrive/import — 백업 가져오기 (F3)
  router.post('/gdrive/import', async (req, res) => {
    try {
      const user = getUserFromReq(req);
      if (!user || user.id === 'local') return res.status(401).json({ error: 'login required' });

      const { fileId } = req.body;
      if (!fileId) return res.status(400).json({ error: 'fileId required' });

      const accessToken = await auth.getValidGoogleToken(user.id);
      if (!accessToken) return res.status(400).json({ error: 'Google Drive 연결 필요' });

      const backupData = await gdriveUserBackup.downloadBackup(fileId, accessToken);
      const result = gdriveUserBackup.importBackupData(backupData, user.id, dbModule);

      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[gdrive/import]', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}

module.exports = createGdriveRouter;
