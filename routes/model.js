/**
 * routes/model.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Ollama 커스텀 모델 관리 API
 *
 * 엔드포인트:
 *   GET    /api/model/status         — Ollama 연결 상태 + 활성 모델
 *   GET    /api/model/list           — 사용 가능한 orbit-* 모델 목록
 *   POST   /api/model/train          — 학습 데이터 추출 + 모델 생성 (비동기)
 *   POST   /api/model/activate       — { modelName } → 활성 모델 변경
 *   GET    /api/model/training-data  — 학습 데이터 파일 목록 + 미리보기
 *   DELETE /api/model/:name          — orbit-* 모델 삭제
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');

/**
 * @param {{ getAllEvents: Function, modelTrainer: object, broadcastAll: Function }} deps
 * @returns {express.Router}
 */
function createRouter({ getAllEvents, modelTrainer, broadcastAll }) {
  const router = express.Router();

  // ─── GET /api/model/status ──────────────────────────────────────────────────
  // Ollama 서버 연결 상태 + 현재 활성 모델 정보 반환
  router.get('/model/status', async (req, res) => {
    try {
      const [ollamaStatus, activeModel, models] = await Promise.all([
        modelTrainer.checkOllamaStatus(),
        Promise.resolve(modelTrainer.getActiveModel()),
        Promise.resolve(modelTrainer.listAvailableModels()),
      ]);

      res.json({
        ok: true,
        ollama: ollamaStatus,
        activeModel,
        modelCount: models.length,
        isCustomModel: activeModel.startsWith('orbit-'),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── GET /api/model/list ────────────────────────────────────────────────────
  // 현재 Ollama에 등록된 orbit-* 모델 목록 반환
  router.get('/model/list', (req, res) => {
    try {
      const models      = modelTrainer.listAvailableModels();
      const activeModel = modelTrainer.getActiveModel();

      const modelsWithActive = models.map(m => ({
        ...m,
        isActive: m.name === activeModel,
      }));

      res.json({ ok: true, models: modelsWithActive, activeModel });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── POST /api/model/train ──────────────────────────────────────────────────
  // 학습 데이터 추출 + ollama create 실행 (스트리밍 진행 상황 응답)
  // WebSocket으로도 진행 상황 브로드캐스트
  router.post('/model/train', async (req, res) => {
    // 이미 학습 진행 중인지 간단 체크 (프로세스 레벨)
    if (global._orbitTraining) {
      return res.status(409).json({ ok: false, error: '이미 학습이 진행 중입니다.' });
    }

    global._orbitTraining = true;
    const progress = [];

    // 클라이언트에 즉시 200 응답 (비동기 작업 시작 알림)
    res.json({
      ok: true,
      message: '학습이 시작되었습니다. WebSocket으로 진행 상황을 확인하세요.',
      wsEvent: 'model_training',
    });

    // 비동기 학습 실행
    setImmediate(async () => {
      try {
        const events = getAllEvents();

        if (events.length < 10) {
          broadcastAll({
            type:    'model_training',
            step:    'error',
            message: '학습에 필요한 이벤트가 부족합니다 (최소 10개 필요).',
          });
          return;
        }

        await modelTrainer.trainModel(events, step => {
          progress.push(step);
          // WebSocket으로 진행 상황 실시간 브로드캐스트
          broadcastAll({
            type: 'model_training',
            ...step,
          });
        });

      } catch (err) {
        broadcastAll({
          type:    'model_training',
          step:    'error',
          message: err.message,
        });
        console.error('[model-router] 학습 오류:', err.message);
      } finally {
        global._orbitTraining = false;
      }
    });
  });

  // ─── POST /api/model/activate ───────────────────────────────────────────────
  // 특정 모델을 활성 모델로 변경
  router.post('/model/activate', (req, res) => {
    const { modelName } = req.body || {};

    if (!modelName) {
      return res.status(400).json({ ok: false, error: 'modelName 필드가 필요합니다.' });
    }

    try {
      modelTrainer.setActiveModel(modelName);
      broadcastAll({ type: 'model_activated', modelName });
      res.json({ ok: true, activeModel: modelName });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── GET /api/model/training-data ──────────────────────────────────────────
  // 학습 데이터 파일 목록 + 최근 파일 미리보기
  router.get('/model/training-data', (req, res) => {
    try {
      const limit   = Math.min(parseInt(req.query.limit) || 5, 20);
      const files   = modelTrainer.listTrainingFiles();
      const preview = modelTrainer.previewTrainingData(limit);

      res.json({
        ok: true,
        files,
        preview,
        totalFiles: files.length,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── DELETE /api/model/:name ────────────────────────────────────────────────
  // orbit-* 모델 삭제 (기본 모델은 삭제 불가)
  router.delete('/model/:name', (req, res) => {
    const { name } = req.params;

    if (!name || !name.startsWith('orbit-')) {
      return res.status(400).json({
        ok: false,
        error: 'orbit-* 모델만 삭제할 수 있습니다.',
      });
    }

    const result = modelTrainer.deleteModel(name);

    if (result.ok) {
      broadcastAll({ type: 'model_deleted', modelName: name });
      res.json({ ok: true, deleted: name });
    } else {
      res.status(500).json({ ok: false, error: result.error });
    }
  });

  return router;
}

module.exports = createRouter;
