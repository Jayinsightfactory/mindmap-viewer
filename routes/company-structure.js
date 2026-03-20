'use strict';
/**
 * company-structure.js — 회사 구조/업무 파악 에이전트 + 장기 트리거 모니터
 *
 * 에이전트 1: 회사 구조 분석 — 직원 역할, 거래처 담당, 업무 흐름, 병목
 * 에이전트 2: 트리거 모니터 — 장기 패턴 변화, 이상 징후, 트렌드
 */
const express = require('express');

function createCompanyStructureRouter({ getDb }) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════════
  // GET /api/company/structure — 회사 구조 분석 (데이터 기반 조직도)
  // ═══════════════════════════════════════════════════════════════
  router.get('/structure', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const days = parseInt(req.query.days || '7');

      // 1. 직원별 역할 판정 (앱 사용 + 윈도우 패턴)
      const rolesRes = await db.query(`
        SELECT e.user_id, u.name,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '주문') as order_work,
          COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '발주') as purchase_work,
          COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* 'Excel') as excel_work,
          COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '(카카오톡|네노바)') as comm_work,
          COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '(Claude|ChatGPT|PowerShell|cmd)') as dev_work,
          COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '(매출|원가|보고|결산)') as finance_work,
          COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '(출고|배송|현장)') as shipping_work,
          COUNT(*) FILTER (WHERE e.type = 'idle') as idle_count,
          MIN(e.timestamp) as first_seen,
          MAX(e.timestamp) as last_seen,
          -- 근무시간 추정 (첫 활동 ~ 마지막 활동)
          EXTRACT(EPOCH FROM (MAX(e.timestamp::timestamptz) - MIN(e.timestamp::timestamptz))) / 3600 as work_hours
        FROM events e
        LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.timestamp::timestamptz > NOW() - INTERVAL '${days} days'
          AND e.type IN ('keyboard.chunk', 'screen.capture', 'idle')
          AND e.user_id NOT IN ('MMOLABXL2066516519') -- Claude Code 세션 제외
        GROUP BY e.user_id, u.name
        HAVING COUNT(*) >= 5
        ORDER BY total DESC
      `);

      // 2. 거래처 담당 관계
      const custRes = await db.query(`
        SELECT mc.name as customer, mc.region, mc.staff,
          (SELECT COUNT(*) FROM events
           WHERE COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE '%' || mc.name || '%'
             AND type IN ('keyboard.chunk', 'screen.capture')
             AND timestamp::timestamptz > NOW() - INTERVAL '${days} days') as events
        FROM master_customers mc
        ORDER BY events DESC
      `);

      // 3. 협업 관계 (공유 채팅방)
      const collabRes = await db.query(`
        SELECT
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as chatroom,
          array_agg(DISTINCT user_id) as participants,
          COUNT(*) as events
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND timestamp::timestamptz > NOW() - INTERVAL '${days} days'
          AND COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '네노바'
        GROUP BY chatroom
        HAVING COUNT(DISTINCT user_id) >= 2
        ORDER BY events DESC
        LIMIT 20
      `);

      // 역할 자동 판정
      const members = rolesRes.rows.map(r => {
        const total = parseInt(r.total) || 1;
        const scores = {
          sales: (parseInt(r.order_work) + parseInt(r.comm_work) * 0.3) / total,
          purchasing: parseInt(r.purchase_work) / total,
          data: (parseInt(r.excel_work) + parseInt(r.dev_work)) / total,
          finance: parseInt(r.finance_work) / total,
          shipping: parseInt(r.shipping_work) / total,
        };
        const topRole = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
        const roleMap = {
          sales: '영업/주문관리', purchasing: '수입/발주', data: '전산/데이터',
          finance: '경영/재무', shipping: '현장/출고',
        };

        const idleRatio = parseInt(r.idle_count) / total;
        let status = 'active';
        if (idleRatio > 0.8) status = 'mostly_idle';
        else if (parseInt(r.total) < 20) status = 'low_activity';

        return {
          userId: r.user_id,
          name: r.name || r.user_id.substring(0, 8),
          role: roleMap[topRole[0]] || '미분류',
          roleScore: +(topRole[1] * 100).toFixed(1),
          totalEvents: parseInt(r.total),
          breakdown: {
            order: parseInt(r.order_work),
            purchase: parseInt(r.purchase_work),
            excel: parseInt(r.excel_work),
            communication: parseInt(r.comm_work),
            development: parseInt(r.dev_work),
            finance: parseInt(r.finance_work),
            shipping: parseInt(r.shipping_work),
            idle: parseInt(r.idle_count),
          },
          workHours: +parseFloat(r.work_hours || 0).toFixed(1),
          status,
        };
      });

      res.json({
        analyzedDays: days,
        members,
        customers: custRes.rows.map(r => ({
          name: r.customer, region: r.region, staff: r.staff, events: parseInt(r.events),
        })),
        collaboration: collabRes.rows.map(r => ({
          chatroom: r.chatroom, participants: r.participants, events: parseInt(r.events),
        })),
        bottlenecks: _detectBottlenecks(members),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/company/triggers — 장기 트리거 모니터 (트렌드 변화 감지)
  // ═══════════════════════════════════════════════════════════════
  router.get('/triggers', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const triggers = [];

      // Trigger 1: 일별 이벤트 볼륨 변화 (급증/급감)
      const dailyRes = await db.query(`
        SELECT date_trunc('day', timestamp::timestamptz) as day,
          COUNT(*) as total,
          COUNT(DISTINCT user_id) as users
        FROM events
        WHERE timestamp::timestamptz > NOW() - INTERVAL '7 days'
          AND type IN ('keyboard.chunk', 'screen.capture')
        GROUP BY day ORDER BY day
      `);
      const dailyVolumes = dailyRes.rows.map(r => ({ day: r.day, total: parseInt(r.total), users: parseInt(r.users) }));
      if (dailyVolumes.length >= 2) {
        const last = dailyVolumes[dailyVolumes.length - 1];
        const prev = dailyVolumes[dailyVolumes.length - 2];
        const change = prev.total > 0 ? ((last.total - prev.total) / prev.total * 100) : 0;
        if (Math.abs(change) > 30) {
          triggers.push({
            type: 'VOLUME_CHANGE',
            severity: Math.abs(change) > 50 ? 'warning' : 'info',
            detail: `일일 이벤트 ${change > 0 ? '급증' : '급감'} ${Math.round(change)}% (${prev.total}→${last.total})`,
            data: { prev: prev.total, current: last.total, changePct: Math.round(change) },
          });
        }
      }

      // Trigger 2: 새 거래처 등장 (처음 보는 채팅방)
      const newCustRes = await db.query(`
        SELECT DISTINCT COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as win
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
          AND COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '(네노바|\\+)'
          AND COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') NOT IN (
            SELECT DISTINCT COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow')
            FROM events
            WHERE type IN ('keyboard.chunk', 'screen.capture')
              AND timestamp::timestamptz BETWEEN NOW() - INTERVAL '7 days' AND NOW() - INTERVAL '24 hours'
          )
      `);
      for (const r of newCustRes.rows) {
        if (r.win) {
          triggers.push({
            type: 'NEW_CUSTOMER',
            severity: 'info',
            detail: `새 거래처/채팅방 감지: "${r.win}"`,
            data: { window: r.win },
          });
        }
      }

      // Trigger 3: 직원 활동 패턴 변화 (평소 대비)
      const activityRes = await db.query(`
        WITH daily AS (
          SELECT user_id, date_trunc('day', timestamp::timestamptz) as day, COUNT(*) as cnt
          FROM events
          WHERE type IN ('keyboard.chunk', 'screen.capture')
            AND timestamp::timestamptz > NOW() - INTERVAL '7 days'
          GROUP BY user_id, day
        )
        SELECT user_id,
          AVG(cnt) as avg_daily,
          MAX(cnt) FILTER (WHERE day = date_trunc('day', NOW())) as today,
          STDDEV(cnt) as stddev
        FROM daily
        GROUP BY user_id
        HAVING COUNT(*) >= 2
      `);
      for (const r of activityRes.rows) {
        const avg = parseFloat(r.avg_daily) || 0;
        const today = parseInt(r.today) || 0;
        const stddev = parseFloat(r.stddev) || 1;
        if (avg > 0 && (today < avg - 2 * stddev || today > avg + 2 * stddev)) {
          triggers.push({
            type: 'ACTIVITY_ANOMALY',
            severity: today < avg * 0.3 ? 'warning' : 'info',
            detail: `${r.user_id.substring(0, 12)} 활동 이상: 오늘 ${today} (평균 ${Math.round(avg)}±${Math.round(stddev)})`,
            data: { userId: r.user_id, today, avgDaily: Math.round(avg), stddev: Math.round(stddev) },
          });
        }
      }

      // Trigger 4: 새 품목 대량 등장 (계절 변화 감지)
      const newProdRes = await db.query(`
        SELECT COUNT(*) as new_products
        FROM master_products
        WHERE first_seen > NOW() - INTERVAL '24 hours'
          AND source LIKE 'auto%'
      `);
      const newProds = parseInt(newProdRes.rows[0]?.new_products || 0);
      if (newProds > 10) {
        triggers.push({
          type: 'SEASON_CHANGE',
          severity: 'info',
          detail: `24시간 내 ${newProds}개 신규 품목 자동 등록 — 시즌 변화 가능성`,
          data: { newProducts: newProds },
        });
      }

      // Trigger 5: 자동화율 변화
      const autoRes = await db.query(`
        SELECT
          COUNT(*) FILTER (WHERE data_json->>'automatable' = 'true'
            AND timestamp::timestamptz > NOW() - INTERVAL '24 hours') as auto_today,
          COUNT(*) FILTER (WHERE timestamp::timestamptz > NOW() - INTERVAL '24 hours') as total_today,
          COUNT(*) FILTER (WHERE data_json->>'automatable' = 'true'
            AND timestamp::timestamptz BETWEEN NOW() - INTERVAL '48 hours' AND NOW() - INTERVAL '24 hours') as auto_yesterday,
          COUNT(*) FILTER (WHERE timestamp::timestamptz BETWEEN NOW() - INTERVAL '48 hours' AND NOW() - INTERVAL '24 hours') as total_yesterday
        FROM events WHERE type = 'screen.analyzed'
      `);
      const ar = autoRes.rows[0] || {};
      const todayRate = parseInt(ar.total_today) > 0 ? parseInt(ar.auto_today) / parseInt(ar.total_today) : 0;
      const yesterdayRate = parseInt(ar.total_yesterday) > 0 ? parseInt(ar.auto_yesterday) / parseInt(ar.total_yesterday) : 0;
      if (Math.abs(todayRate - yesterdayRate) > 0.15) {
        triggers.push({
          type: 'AUTOMATION_RATE_CHANGE',
          severity: 'info',
          detail: `자동화율 변화: ${Math.round(yesterdayRate * 100)}% → ${Math.round(todayRate * 100)}%`,
          data: { yesterday: Math.round(yesterdayRate * 100), today: Math.round(todayRate * 100) },
        });
      }

      // Trigger 6: 근무시간 이상 (야근/조퇴 감지)
      const hoursRes = await db.query(`
        SELECT e.user_id, u.name,
          MIN(EXTRACT(HOUR FROM e.timestamp::timestamptz AT TIME ZONE 'Asia/Seoul')) as earliest_hour,
          MAX(EXTRACT(HOUR FROM e.timestamp::timestamptz AT TIME ZONE 'Asia/Seoul')) as latest_hour
        FROM events e
        LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type IN ('keyboard.chunk', 'screen.capture')
          AND e.timestamp::timestamptz > NOW() - INTERVAL '24 hours'
        GROUP BY e.user_id, u.name
        HAVING COUNT(*) >= 10
      `);
      for (const r of hoursRes.rows) {
        const latest = parseInt(r.latest_hour);
        const earliest = parseInt(r.earliest_hour);
        if (latest >= 21) {
          triggers.push({
            type: 'OVERTIME',
            severity: 'warning',
            detail: `${r.name || r.user_id.substring(0, 8)} 야근 감지 (${latest}시까지 활동)`,
            data: { userId: r.user_id, latestHour: latest },
          });
        }
        if (earliest >= 14) {
          triggers.push({
            type: 'LATE_START',
            severity: 'info',
            detail: `${r.name || r.user_id.substring(0, 8)} 늦은 시작 (${earliest}시 첫 활동)`,
            data: { userId: r.user_id, earliestHour: earliest },
          });
        }
      }

      // Trigger 7: DB 용량 체크
      const dbRes = await db.query(`SELECT pg_database_size('railway') as bytes`);
      const dbMB = parseInt(dbRes.rows[0]?.bytes || 0) / 1024 / 1024;
      if (dbMB > 768) {
        triggers.push({
          type: 'DB_CAPACITY',
          severity: 'warning',
          detail: `DB 용량 ${Math.round(dbMB)}MB / 1024MB (${Math.round(dbMB / 1024 * 100)}%)`,
          data: { sizeMB: Math.round(dbMB) },
        });
      }

      triggers.sort((a, b) => {
        const s = { warning: 0, info: 1 };
        return (s[a.severity] || 9) - (s[b.severity] || 9);
      });

      res.json({
        checkedAt: new Date().toISOString(),
        totalTriggers: triggers.length,
        triggers,
        dailyVolumes,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 장기 트리거 자동 체크 — 3시간마다
  // ═══════════════════════════════════════════════════════════════
  async function _autoTriggerCheck() {
    try {
      const db = getDb();
      if (!db?.query) return;

      // 간이 체크: 야근 + 볼륨 급변만
      const overtime = await db.query(`
        SELECT e.user_id, u.name,
          MAX(EXTRACT(HOUR FROM e.timestamp::timestamptz AT TIME ZONE 'Asia/Seoul')) as latest
        FROM events e LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type IN ('keyboard.chunk','screen.capture')
          AND e.timestamp::timestamptz > NOW() - INTERVAL '6 hours'
        GROUP BY e.user_id, u.name
        HAVING MAX(EXTRACT(HOUR FROM e.timestamp::timestamptz AT TIME ZONE 'Asia/Seoul')) >= 21
      `);
      for (const r of overtime.rows) {
        console.log(`[company-trigger] ⚠️ 야근 감지: ${r.name || r.user_id.substring(0, 8)} (${r.latest}시)`);
      }

      const vol = await db.query(`
        SELECT COUNT(*) as cnt FROM events
        WHERE timestamp::timestamptz > NOW() - INTERVAL '3 hours'
          AND type IN ('keyboard.chunk','screen.capture')
      `);
      console.log(`[company-trigger] 3시간 체크: ${vol.rows[0]?.cnt || 0}건 이벤트`);
    } catch (err) {
      console.error('[company-trigger] 에러:', err.message);
    }
  }

  setTimeout(() => {
    _autoTriggerCheck();
    setInterval(_autoTriggerCheck, 3 * 60 * 60 * 1000);
  }, 4 * 60 * 1000);

  console.log('[company-structure] 회사 구조 분석 + 트리거 모니터 시작 (3시간마다)');

  return router;
}

// 병목 자동 감지
function _detectBottlenecks(members) {
  const bottlenecks = [];
  const sorted = [...members].sort((a, b) => b.totalEvents - a.totalEvents);

  // 1인 과부하
  if (sorted.length >= 2 && sorted[0].totalEvents > sorted[1].totalEvents * 2.5) {
    bottlenecks.push({
      type: 'WORKLOAD_CONCENTRATION',
      severity: 'critical',
      detail: `${sorted[0].name}에 업무 과도 집중 (${sorted[0].totalEvents}건, 2위 대비 ${(sorted[0].totalEvents / sorted[1].totalEvents).toFixed(1)}배)`,
      member: sorted[0].name,
    });
  }

  // idle 과다
  for (const m of members) {
    if (m.breakdown.idle > 100 && m.breakdown.idle / m.totalEvents > 0.8) {
      bottlenecks.push({
        type: 'HIGH_IDLE',
        severity: 'warning',
        detail: `${m.name} idle ${Math.round(m.breakdown.idle / m.totalEvents * 100)}% (${m.breakdown.idle}건)`,
        member: m.name,
      });
    }
  }

  // 야근
  for (const m of members) {
    if (m.workHours > 12) {
      bottlenecks.push({
        type: 'OVERTIME',
        severity: 'warning',
        detail: `${m.name} 근무시간 ${m.workHours.toFixed(1)}시간`,
        member: m.name,
      });
    }
  }

  return bottlenecks;
}

module.exports = createCompanyStructureRouter;
