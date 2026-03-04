'use strict';
/**
 * src/company-crawler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 회사 전용 DB 크롤러 — 사내 데이터 수집 + 자동 분석
 *
 * 수집 대상:
 *   1. 공유 폴더 / NAS 내 엑셀/문서 파일
 *   2. 직원 PC 트래커 데이터 (자동 수집)
 *   3. 수동 업로드 (API 통해)
 *
 * 스케줄러:
 *   - 10분마다: 직원 활동 집계
 *   - 1시간마다: 학습 엔진 실행
 *   - 6시간마다: Google Drive 백업
 *   - 매일: 진단 리프레시 + 이상 탐지
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path = require('path');
const fs = require('fs');

let _timers = [];
let _running = false;

function start({ db, broadcastAll }) {
  if (_running) return;
  _running = true;
  console.log('[company-crawler] 시작');

  const ontology = requireSafe('../src/company-ontology');
  const learningEngine = requireSafe('../src/company-learning-engine');
  const gdriveBackup = requireSafe('../src/gdrive-backup');

  if (ontology) ontology.ensureCompanyTables(db);

  // ── 10분마다: 직원 활동 집계 + 실시간 요약 ────────────────────────────
  _timers.push(setInterval(() => {
    try {
      if (!ontology) return;
      const companies = ontology.listCompanies(db, { limit: 50 });
      for (const company of companies) {
        const since = new Date(Date.now() - 600_000).toISOString(); // 최근 10분
        const stats = ontology.getActivityStats(db, company.id, since);

        if (stats.totalActivities > 0 && broadcastAll) {
          broadcastAll({
            type: 'company_activity_update',
            companyId: company.id,
            companyName: company.name,
            stats: {
              activeEmployees: stats.activeEmployees,
              activities: stats.totalActivities,
            },
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (e) {
      console.error('[company-crawler] 활동 집계 오류:', e.message);
    }
  }, 10 * 60_000));

  // ── 1시간마다: 학습 엔진 실행 ─────────────────────────────────────────
  _timers.push(setInterval(() => {
    try {
      if (!learningEngine || !ontology) return;
      const companies = ontology.listCompanies(db, { limit: 50 });
      for (const company of companies) {
        const report = learningEngine.generateCompanyLearningReport(db, company.id);
        if (report && broadcastAll) {
          broadcastAll({
            type: 'company_learning_update',
            companyId: company.id,
            summary: report.summary,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (e) {
      console.error('[company-crawler] 학습 엔진 오류:', e.message);
    }
  }, 60 * 60_000));

  // ── 매일 자정: 진단 리프레시 + 이상 탐지 ──────────────────────────────
  _timers.push(setInterval(() => {
    try {
      if (!learningEngine || !ontology) return;
      const diagEngine = requireSafe('../src/diagnosis-engine');
      const companies = ontology.listCompanies(db, { status: 'retainer', limit: 50 });
      for (const company of companies) {
        // 월정액 고객은 매일 자동 진단
        if (diagEngine) diagEngine.runDiagnosis(db, company.id, 'monthly');

        // 이상 징후 탐지
        const anomalies = learningEngine.detectAnomalies(db, company.id);
        if (anomalies.length > 0 && broadcastAll) {
          broadcastAll({
            type: 'company_anomalies',
            companyId: company.id,
            companyName: company.name,
            anomalies: anomalies.slice(0, 5),
            total: anomalies.length,
          });
        }
      }
    } catch (e) {
      console.error('[company-crawler] 일일 진단 오류:', e.message);
    }
  }, 24 * 60 * 60_000));

  // ── Google Drive 백업 (6시간) ─────────────────────────────────────────
  if (gdriveBackup) {
    gdriveBackup.start(db);
  }

  // 즉시 1회 실행
  setTimeout(() => {
    try {
      if (learningEngine && ontology) {
        const companies = ontology.listCompanies(db, { limit: 5 });
        for (const company of companies) {
          learningEngine.generateCompanyLearningReport(db, company.id);
        }
      }
    } catch {}
  }, 5000);

  console.log('[company-crawler] 스케줄러 활성화');
  console.log('  📊 활동 집계: 10분마다');
  console.log('  🧠 학습 엔진: 1시간마다');
  console.log('  🏥 자동 진단: 매일 (월정액 고객)');
  console.log('  💾 GDrive 백업: 6시간마다');
}

function stop() {
  _timers.forEach(t => clearInterval(t));
  _timers = [];
  _running = false;
  console.log('[company-crawler] 중지');
}

function requireSafe(p) {
  try { return require(path.resolve(__dirname, '..', p)); } catch { return null; }
}

module.exports = { start, stop };
