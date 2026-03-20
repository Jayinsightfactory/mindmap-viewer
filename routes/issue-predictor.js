'use strict';
const express = require('express');

function createIssuePredictorRouter({ getDb }) {
  const router = express.Router();

// GET /api/issues/scan — 전체 이슈 스캔 (8개 규칙)
router.get('/scan', async (req, res) => {
  try {
    const db = getDb();
    if (!db?.query) return res.json({ issues: [], error: 'DB not available' });

    const issues = [];
    const now = new Date();

    // Rule 1: 과거 주문 접근 (D-3 이상 날짜 윈도우)
    const pastOrders = await db.query(`
      SELECT user_id,
        COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as win_title,
        COUNT(*) as visits,
        MAX(timestamp) as last_seen
      FROM events
      WHERE type IN ('keyboard.chunk', 'screen.capture')
        AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
        AND (
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~ '202[0-9]-[0-9]{2}-[0-9]{2}'
        )
      GROUP BY user_id, win_title
      HAVING COUNT(*) >= 3
      ORDER BY visits DESC
    `);

    for (const row of pastOrders.rows) {
      const dateMatch = row.win_title?.match(/(202\d-\d{2}-\d{2})/);
      if (dateMatch) {
        const orderDate = new Date(dateMatch[1]);
        const daysDiff = Math.floor((now - orderDate) / (1000*60*60*24));
        if (daysDiff >= 3) {
          issues.push({
            rule: 'PAST_ORDER_ACCESS',
            severity: daysDiff >= 7 ? 'critical' : 'warning',
            userId: row.user_id,
            detail: `${daysDiff}일 전 주문 "${row.win_title}" 에 ${row.visits}회 접근`,
            window: row.win_title,
            visits: parseInt(row.visits),
            daysDiff,
            lastSeen: row.last_seen,
          });
        }
      }
    }

    // Rule 2: 반복 작업 감지 (동일 화면 100회+/일)
    const repetitive = await db.query(`
      SELECT user_id,
        COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as win_title,
        COUNT(*) as visits
      FROM events
      WHERE type IN ('keyboard.chunk', 'screen.capture')
        AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
      GROUP BY user_id, win_title
      HAVING COUNT(*) >= 100
      ORDER BY visits DESC
    `);

    for (const row of repetitive.rows) {
      if (row.win_title) {
        issues.push({
          rule: 'REPETITIVE_WORK',
          severity: parseInt(row.visits) >= 200 ? 'critical' : 'warning',
          userId: row.user_id,
          detail: `"${row.win_title}" 화면 ${row.visits}회 반복 — 자동화 기회`,
          window: row.win_title,
          visits: parseInt(row.visits),
        });
      }
    }

    // Rule 3: 근무시간 공백 (10:00~18:00 KST, 30분+)
    const gaps = await db.query(`
      WITH ordered AS (
        SELECT user_id, timestamp,
          LEAD(timestamp) OVER (PARTITION BY user_id ORDER BY timestamp) as next_ts
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
      )
      SELECT user_id, timestamp as gap_start, next_ts as gap_end,
        EXTRACT(EPOCH FROM (next_ts::timestamp - timestamp::timestamp))/60 as gap_minutes
      FROM ordered
      WHERE EXTRACT(EPOCH FROM (next_ts::timestamp - timestamp::timestamp))/60 > 30
        AND EXTRACT(HOUR FROM timestamp::timestamp AT TIME ZONE 'Asia/Seoul') BETWEEN 10 AND 17
      ORDER BY gap_minutes DESC
      LIMIT 20
    `);

    for (const row of gaps.rows) {
      const gapMin = Math.round(parseFloat(row.gap_minutes));
      if (gapMin <= 480) { // 8시간 이하만 (야간 제외)
        issues.push({
          rule: 'WORK_HOUR_GAP',
          severity: gapMin >= 60 ? 'warning' : 'info',
          userId: row.user_id,
          detail: `근무시간 중 ${gapMin}분 공백 (${row.gap_start} ~ ${row.gap_end})`,
          gapMinutes: gapMin,
          gapStart: row.gap_start,
          gapEnd: row.gap_end,
        });
      }
    }

    // Rule 4: idle 비율 80%+ (근무시간)
    const idleRatio = await db.query(`
      SELECT user_id,
        COUNT(*) FILTER (WHERE type = 'idle') as idle_count,
        COUNT(*) FILTER (WHERE type IN ('keyboard.chunk', 'screen.capture')) as active_count,
        COUNT(*) as total
      FROM events
      WHERE timestamp::timestamptz > NOW() - INTERVAL '24 hours'
        AND type IN ('idle', 'keyboard.chunk', 'screen.capture')
      GROUP BY user_id
      HAVING COUNT(*) FILTER (WHERE type = 'idle') > 0
    `);

    for (const row of idleRatio.rows) {
      const total = parseInt(row.idle_count) + parseInt(row.active_count);
      const ratio = total > 0 ? parseInt(row.idle_count) / total : 0;
      if (ratio >= 0.8 && parseInt(row.idle_count) > 50) {
        issues.push({
          rule: 'HIGH_IDLE_RATIO',
          severity: ratio >= 0.9 ? 'critical' : 'warning',
          userId: row.user_id,
          detail: `idle 비율 ${(ratio*100).toFixed(0)}% (idle ${row.idle_count}건 / 활동 ${row.active_count}건)`,
          idleCount: parseInt(row.idle_count),
          activeCount: parseInt(row.active_count),
          ratio: Math.round(ratio * 100),
        });
      }
    }

    // Rule 5: 비업무 비율 50%+ (known non-work patterns)
    const nonWork = await db.query(`
      SELECT user_id,
        COUNT(*) FILTER (WHERE
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '(고슴도치|쇼핑|무신사|디젤|검색|네이버 카페|유튜브|인스타|페이스북|게임|엄마|가족|바보)'
        ) as non_work,
        COUNT(*) as total
      FROM events
      WHERE type IN ('keyboard.chunk', 'screen.capture')
        AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
      GROUP BY user_id
      HAVING COUNT(*) >= 20
    `);

    for (const row of nonWork.rows) {
      const ratio = parseInt(row.total) > 0 ? parseInt(row.non_work) / parseInt(row.total) : 0;
      if (ratio >= 0.3 && parseInt(row.non_work) >= 10) {
        issues.push({
          rule: 'NON_WORK_RATIO',
          severity: ratio >= 0.5 ? 'warning' : 'info',
          userId: row.user_id,
          detail: `비업무 활동 ${(ratio*100).toFixed(0)}% (${row.non_work}건 / ${row.total}건)`,
          nonWorkCount: parseInt(row.non_work),
          totalCount: parseInt(row.total),
          ratio: Math.round(ratio * 100),
        });
      }
    }

    // Rule 6: bank.security 후 복구 체크
    const bankEvents = await db.query(`
      SELECT e1.user_id, e1.timestamp as bank_time,
        (SELECT MIN(e2.timestamp) FROM events e2
         WHERE e2.user_id = e1.user_id
           AND e2.type IN ('keyboard.chunk', 'screen.capture')
           AND e2.timestamp::timestamptz > e1.timestamp::timestamptz) as recovery_time
      FROM events e1
      WHERE e1.type = 'bank.security.active'
        AND e1.timestamp::timestamptz > NOW() - INTERVAL '48 hours'
      ORDER BY e1.timestamp DESC
    `);

    for (const row of bankEvents.rows) {
      if (row.recovery_time) {
        const recoveryMin = (new Date(row.recovery_time) - new Date(row.bank_time)) / 60000;
        if (recoveryMin > 5) {
          issues.push({
            rule: 'BANK_SECURITY_SLOW_RECOVERY',
            severity: recoveryMin > 30 ? 'warning' : 'info',
            userId: row.user_id,
            detail: `은행 보안 활성 후 ${Math.round(recoveryMin)}분 만에 복구`,
            bankTime: row.bank_time,
            recoveryTime: row.recovery_time,
            recoveryMinutes: Math.round(recoveryMin),
          });
        }
      } else {
        issues.push({
          rule: 'BANK_SECURITY_NO_RECOVERY',
          severity: 'critical',
          userId: row.user_id,
          detail: `은행 보안 활성 후 활동 복구 안 됨`,
          bankTime: row.bank_time,
        });
      }
    }

    // Rule 7: 주문-차감 불일치 (rawInput 기반 정밀 분류)
    // 윈도우 타이틀 + rawInput 내용 + 클릭패턴으로 주문/차감 구분
    const orderDeduction = await db.query(`
      SELECT user_id,
        -- 윈도우 기반 (기존)
        COUNT(*) FILTER (WHERE
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '주문'
        ) as win_order,
        COUNT(*) FILTER (WHERE
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '차감'
        ) as win_deduction,
        -- rawInput 기반 (신규): 숫자+코드 패턴 = 주문 입력, 재고/수량 문구 = 차감
        COUNT(*) FILTER (WHERE
          data_json->>'rawInput' IS NOT NULL
          AND data_json->>'rawInput' ~ '[0-9]{2,}'
          AND COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '(주문|화훼 관리)'
          AND (data_json->>'mouseClicks')::int > 15
        ) as raw_order,
        COUNT(*) FILTER (WHERE
          data_json->>'rawInput' IS NOT NULL
          AND (data_json->>'rawInput' ~* '(cnfrh|sodurtj|qnxkremf|차감|재고|수량|확인)'
            OR COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '차감')
        ) as raw_deduction,
        -- Excel 차감내역 파일 접근
        COUNT(*) FILTER (WHERE
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '차감내역.*Excel'
        ) as excel_deduction
      FROM events
      WHERE type = 'keyboard.chunk'
        AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
      GROUP BY user_id
      HAVING COUNT(*) FILTER (WHERE
        COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '주문'
        OR (data_json->>'rawInput' IS NOT NULL AND (data_json->>'mouseClicks')::int > 15)
      ) >= 5
    `);

    for (const row of orderDeduction.rows) {
      // rawInput이 있으면 정밀 분류, 없으면 윈도우 기반 폴백
      const orderCount = parseInt(row.raw_order) || parseInt(row.win_order);
      const deductCount = parseInt(row.raw_deduction) + parseInt(row.excel_deduction) || parseInt(row.win_deduction);
      const ratio = deductCount > 0 ? orderCount / deductCount : orderCount;

      if (orderCount >= 10 && ratio > 5) {
        const hasRawInput = parseInt(row.raw_order) > 0;
        issues.push({
          rule: 'ORDER_DEDUCTION_MISMATCH',
          severity: deductCount === 0 ? 'critical' : ratio > 20 ? 'warning' : 'info',
          userId: row.user_id,
          detail: `주문 ${orderCount}건 vs 차감 ${deductCount}건 (비율 ${ratio.toFixed(0)}:1) — 대조 누락 가능`,
          orderCount,
          deductionCount: deductCount,
          excelDeduction: parseInt(row.excel_deduction),
          classifiedBy: hasRawInput ? 'rawInput+clicks' : 'windowTitle',
          ratio: Math.round(ratio),
        });
      }
    }

    // Rule 8: 미식별 유저 (idle만 대량, 활동 거의 없음)
    const unidentified = await db.query(`
      SELECT user_id,
        COUNT(*) FILTER (WHERE type = 'idle') as idle_count,
        COUNT(*) FILTER (WHERE type IN ('keyboard.chunk', 'screen.capture')) as active_count
      FROM events
      WHERE timestamp::timestamptz > NOW() - INTERVAL '48 hours'
      GROUP BY user_id
      HAVING COUNT(*) FILTER (WHERE type = 'idle') > 100
        AND COUNT(*) FILTER (WHERE type IN ('keyboard.chunk', 'screen.capture')) < 10
    `);

    for (const row of unidentified.rows) {
      issues.push({
        rule: 'UNIDENTIFIED_IDLE_USER',
        severity: 'warning',
        userId: row.user_id,
        detail: `idle ${row.idle_count}건, 활동 ${row.active_count}건 — PC 방치 또는 미식별 유저`,
        idleCount: parseInt(row.idle_count),
        activeCount: parseInt(row.active_count),
      });
    }

    // Sort by severity
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    issues.sort((a, b) => (severityOrder[a.severity] || 9) - (severityOrder[b.severity] || 9));

    // Summary
    const summary = {
      total: issues.length,
      critical: issues.filter(i => i.severity === 'critical').length,
      warning: issues.filter(i => i.severity === 'warning').length,
      info: issues.filter(i => i.severity === 'info').length,
      scannedAt: new Date().toISOString(),
    };

    res.json({ summary, issues });
  } catch (err) {
    console.error('[issue-predictor] scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/issues/user/:userId — 특정 유저 이슈
router.get('/user/:userId', async (req, res) => {
  try {
    const db = getDb();
    if (!db?.query) return res.json({ issues: [] });

    // 전체 스캔 후 해당 유저만 필터
    const allIssues = [];
    // scan 로직 재사용을 위해 내부 호출 대신 직접 필터
    const scanRes = { json: (d) => d };
    const fakeReq = req;
    const fakeRes = { json: (data) => {
      res.json({ issues: data.issues?.filter(i => i.userId === req.params.userId) || [], count: 0 });
    }, status: (s) => ({ json: (d) => res.status(s).json(d) }) };
    // 간단하게: 유저별 주요 규칙만 직접 실행
    const userId = req.params.userId;
    const issues = [];

    // Rule 1: 과거 주문
    const r1 = await db.query(`
      SELECT COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as win_title,
        COUNT(*) as visits FROM events
      WHERE user_id = $1 AND type IN ('keyboard.chunk','screen.capture') AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
        AND COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~ '202[0-9]-[0-9]{2}-[0-9]{2}'
      GROUP BY win_title HAVING COUNT(*) >= 3`, [userId]);
    for (const row of r1.rows) {
      const m = row.win_title?.match(/(202\d-\d{2}-\d{2})/);
      if (m) {
        const d = Math.floor((new Date() - new Date(m[1])) / 86400000);
        if (d >= 3) issues.push({ rule: 'PAST_ORDER_ACCESS', severity: d>=7?'critical':'warning', detail: `${d}일 전 "${row.win_title}" ${row.visits}회`, visits: +row.visits });
      }
    }

    // Rule 4: idle 비율
    const r4 = await db.query(`
      SELECT COUNT(*) FILTER (WHERE type='idle') as idle_count,
        COUNT(*) FILTER (WHERE type IN ('keyboard.chunk','screen.capture')) as active_count
      FROM events WHERE user_id = $1 AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'`, [userId]);
    if (r4.rows[0]) {
      const ic = +r4.rows[0].idle_count, ac = +r4.rows[0].active_count;
      const ratio = (ic+ac) > 0 ? ic/(ic+ac) : 0;
      if (ratio >= 0.8 && ic > 50) issues.push({ rule: 'HIGH_IDLE_RATIO', severity: ratio>=0.9?'critical':'warning', detail: `idle ${(ratio*100).toFixed(0)}%`, idleCount: ic, activeCount: ac });
    }

    res.json({ userId, issues, count: issues.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

  return router;
}

module.exports = createIssuePredictorRouter;
