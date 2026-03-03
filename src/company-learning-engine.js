'use strict';
/**
 * src/company-learning-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 회사 데이터 학습 + 활용 엔진
 *
 * 직원 활동 데이터를 학습하여:
 *   1. 업무 패턴 발견 (시간대별, 부서별, 앱별)
 *   2. 병목 자동 탐지 (반복 작업, 컨텍스트 스위칭)
 *   3. 자동화 기회 발견 (AI 추천)
 *   4. 이상 징후 감지 (과로, 비효율, 보안 위험)
 *   5. 부서 간 협업 패턴 분석
 *   6. 프로세스 자동 매핑 (활동 → 프로세스 추론)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { ulid } = require('ulid');

// ── 1. 업무 패턴 분석 ──────────────────────────────────────────────────────

function analyzeWorkPatterns(db, companyId, days = 7) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const patterns = {};

  // 시간대별 활동 패턴
  const hourly = db.prepare(`
    SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour,
      COUNT(*) as cnt,
      SUM(duration_sec) as total_sec,
      COUNT(DISTINCT employee_id) as active_employees
    FROM employee_activities
    WHERE company_id = ? AND timestamp > ? AND activity_type = 'active'
    GROUP BY hour ORDER BY hour
  `).all(companyId, since);
  patterns.hourlyActivity = hourly;

  // 피크 시간대
  const peakHour = hourly.reduce((best, h) => h.cnt > (best?.cnt || 0) ? h : best, null);
  patterns.peakHour = peakHour ? { hour: peakHour.hour, activities: peakHour.cnt } : null;

  // 요일별 패턴
  const daily = db.prepare(`
    SELECT CAST(strftime('%w', timestamp) AS INTEGER) as dow,
      COUNT(*) as cnt,
      COUNT(DISTINCT employee_id) as active_employees
    FROM employee_activities
    WHERE company_id = ? AND timestamp > ? AND activity_type = 'active'
    GROUP BY dow ORDER BY dow
  `).all(companyId, since);
  patterns.dailyActivity = daily;

  // 부서별 활동량
  const byDept = db.prepare(`
    SELECT e.department_id, d.name as dept_name,
      COUNT(*) as activity_count,
      COUNT(DISTINCT ea.employee_id) as active_employees,
      SUM(ea.duration_sec) as total_sec
    FROM employee_activities ea
    JOIN employees e ON e.id = ea.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    WHERE ea.company_id = ? AND ea.timestamp > ?
    GROUP BY e.department_id
    ORDER BY activity_count DESC
  `).all(companyId, since);
  patterns.departmentActivity = byDept;

  return patterns;
}

// ── 2. 병목 자동 탐지 ──────────────────────────────────────────────────────

function detectBottlenecks(db, companyId, days = 7) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const bottlenecks = [];

  // 2-1. 반복 작업 탐지 (같은 앱+타이틀 패턴이 하루 N회 이상)
  const repeatedTasks = db.prepare(`
    SELECT app_name,
      SUBSTR(window_title, 1, 100) as title_pattern,
      COUNT(*) as occurrences,
      COUNT(DISTINCT employee_id) as affected_employees,
      SUM(duration_sec) as total_sec,
      DATE(timestamp) as day
    FROM employee_activities
    WHERE company_id = ? AND timestamp > ? AND activity_type = 'active'
    GROUP BY app_name, title_pattern, day
    HAVING occurrences >= 5
    ORDER BY occurrences DESC
    LIMIT 20
  `).all(companyId, since);

  for (const task of repeatedTasks) {
    bottlenecks.push({
      type: 'repeated_task',
      severity: task.occurrences > 15 ? 'high' : 'medium',
      app: task.app_name,
      pattern: task.title_pattern,
      occurrences: task.occurrences,
      affectedEmployees: task.affected_employees,
      totalHours: Math.round(task.total_sec / 3600 * 10) / 10,
      suggestion: `'${task.app_name}' 에서 반복 작업이 하루 ${task.occurrences}회 감지됨. 자동화 검토 필요.`,
    });
  }

  // 2-2. 컨텍스트 스위칭 과다 (짧은 시간 내 앱 전환이 많은 직원)
  const switchingData = db.prepare(`
    SELECT employee_id, e.name,
      COUNT(DISTINCT app_name) as app_count,
      COUNT(*) as total_switches
    FROM employee_activities ea
    JOIN employees e ON e.id = ea.employee_id
    WHERE ea.company_id = ? AND ea.timestamp > ? AND ea.activity_type = 'active'
    GROUP BY employee_id
    HAVING app_count > 10 AND total_switches > 100
    ORDER BY total_switches DESC
    LIMIT 10
  `).all(companyId, since);

  for (const sw of switchingData) {
    const switchRate = Math.round(sw.total_switches / days);
    if (switchRate > 50) {
      bottlenecks.push({
        type: 'context_switching',
        severity: switchRate > 100 ? 'high' : 'medium',
        employee: sw.name,
        employeeId: sw.employee_id,
        appsUsed: sw.app_count,
        dailySwitches: switchRate,
        suggestion: `${sw.name}님이 하루 ${switchRate}회 앱 전환 — 업무 집중 환경 개선 필요`,
      });
    }
  }

  // 2-3. 유휴 시간 과다
  const idleData = db.prepare(`
    SELECT employee_id, e.name,
      SUM(idle_sec) as total_idle,
      SUM(duration_sec) as total_duration,
      CAST(SUM(idle_sec) AS REAL) / NULLIF(SUM(duration_sec), 0) as idle_ratio
    FROM employee_activities ea
    JOIN employees e ON e.id = ea.employee_id
    WHERE ea.company_id = ? AND ea.timestamp > ?
    GROUP BY employee_id
    HAVING idle_ratio > 0.4
    ORDER BY idle_ratio DESC
    LIMIT 10
  `).all(companyId, since);

  for (const idle of idleData) {
    bottlenecks.push({
      type: 'high_idle',
      severity: idle.idle_ratio > 0.6 ? 'high' : 'medium',
      employee: idle.name,
      employeeId: idle.employee_id,
      idleRatio: Math.round(idle.idle_ratio * 100),
      suggestion: `${idle.name}님의 유휴 시간이 ${Math.round(idle.idle_ratio * 100)}% — 업무 배분 검토 필요`,
    });
  }

  return bottlenecks.sort((a, b) => {
    const sev = { high: 3, medium: 2, low: 1 };
    return (sev[b.severity] || 0) - (sev[a.severity] || 0);
  });
}

// ── 3. 자동화 기회 발견 ────────────────────────────────────────────────────

function discoverAutomationOpportunities(db, companyId) {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const opportunities = [];

  // 엑셀 의존도 분석
  const excelUsage = db.prepare(`
    SELECT employee_id, e.name, e.department_id, d.name as dept_name,
      COUNT(*) as excel_activities,
      SUM(duration_sec) as excel_seconds
    FROM employee_activities ea
    JOIN employees e ON e.id = ea.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    WHERE ea.company_id = ? AND ea.timestamp > ?
      AND (ea.app_name LIKE '%excel%' OR ea.app_name LIKE '%EXCEL%'
           OR ea.app_name LIKE '%sheets%' OR ea.app_name LIKE '%calc%')
    GROUP BY employee_id
    HAVING excel_activities > 20
    ORDER BY excel_seconds DESC
  `).all(companyId, since);

  if (excelUsage.length > 0) {
    const totalExcelHrs = excelUsage.reduce((s, e) => s + e.excel_seconds, 0) / 3600;
    opportunities.push({
      type: 'excel_dependency',
      priority: 'high',
      title: '엑셀 업무 자동화',
      description: `${excelUsage.length}명이 월 ${Math.round(totalExcelHrs)}시간을 엑셀에 소요`,
      affectedEmployees: excelUsage.map(e => ({ name: e.name, hours: Math.round(e.excel_seconds / 3600) })),
      estimatedSavingsHrs: Math.round(totalExcelHrs * 0.6), // 60% 자동화 가능
      estimatedSavingsKrw: Math.round(totalExcelHrs * 0.6 * 25000),
    });
  }

  // 이메일 과다 사용
  const emailUsage = db.prepare(`
    SELECT COUNT(*) as cnt, SUM(duration_sec) as total_sec
    FROM employee_activities
    WHERE company_id = ? AND timestamp > ?
      AND (app_name LIKE '%outlook%' OR app_name LIKE '%gmail%'
           OR app_name LIKE '%thunderbird%' OR category = 'email')
  `).get(companyId, since);

  if (emailUsage && emailUsage.total_sec > 100 * 3600) {
    opportunities.push({
      type: 'email_optimization',
      priority: 'medium',
      title: '이메일 커뮤니케이션 최적화',
      description: `월 ${Math.round(emailUsage.total_sec / 3600)}시간이 이메일에 소요됨`,
      estimatedSavingsHrs: Math.round(emailUsage.total_sec / 3600 * 0.3),
      estimatedSavingsKrw: Math.round(emailUsage.total_sec / 3600 * 0.3 * 25000),
    });
  }

  // 수동 데이터 입력 패턴 (반복적 타이핑)
  const dataEntry = db.prepare(`
    SELECT COUNT(*) as sessions,
      SUM(keystrokes) as total_keys,
      SUM(duration_sec) as total_sec
    FROM employee_activities
    WHERE company_id = ? AND timestamp > ?
      AND keystrokes > 100
      AND (app_name LIKE '%excel%' OR app_name LIKE '%erp%'
           OR app_name LIKE '%ecount%' OR app_name LIKE '%douzone%'
           OR window_title LIKE '%입력%' OR window_title LIKE '%등록%')
  `).get(companyId, since);

  if (dataEntry && dataEntry.total_keys > 10000) {
    opportunities.push({
      type: 'data_entry_automation',
      priority: 'high',
      title: '데이터 입력 자동화 (RPA)',
      description: `월 ${dataEntry.sessions}회의 수동 입력 세션, 총 ${dataEntry.total_keys.toLocaleString()}건 키입력`,
      estimatedSavingsHrs: Math.round(dataEntry.total_sec / 3600 * 0.7),
      estimatedSavingsKrw: Math.round(dataEntry.total_sec / 3600 * 0.7 * 25000),
    });
  }

  return opportunities.sort((a, b) => (b.estimatedSavingsKrw || 0) - (a.estimatedSavingsKrw || 0));
}

// ── 4. 이상 징후 감지 ──────────────────────────────────────────────────────

function detectAnomalies(db, companyId) {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const anomalies = [];

  // 야간 작업 (23시~5시)
  const nightWork = db.prepare(`
    SELECT employee_id, e.name, COUNT(*) as night_activities
    FROM employee_activities ea
    JOIN employees e ON e.id = ea.employee_id
    WHERE ea.company_id = ? AND ea.timestamp > ?
      AND (CAST(strftime('%H', ea.timestamp) AS INTEGER) >= 23
           OR CAST(strftime('%H', ea.timestamp) AS INTEGER) <= 5)
      AND ea.activity_type = 'active'
    GROUP BY employee_id
    HAVING night_activities > 10
    ORDER BY night_activities DESC
  `).all(companyId, since);

  for (const nw of nightWork) {
    anomalies.push({
      type: 'night_work',
      severity: nw.night_activities > 30 ? 'high' : 'medium',
      employee: nw.name,
      employeeId: nw.employee_id,
      count: nw.night_activities,
      message: `${nw.name}님이 지난 7일간 ${nw.night_activities}회 야간 작업`,
    });
  }

  // 주말 작업
  const weekendWork = db.prepare(`
    SELECT employee_id, e.name, COUNT(*) as weekend_activities
    FROM employee_activities ea
    JOIN employees e ON e.id = ea.employee_id
    WHERE ea.company_id = ? AND ea.timestamp > ?
      AND CAST(strftime('%w', ea.timestamp) AS INTEGER) IN (0, 6)
      AND ea.activity_type = 'active'
    GROUP BY employee_id
    HAVING weekend_activities > 20
    ORDER BY weekend_activities DESC
  `).all(companyId, since);

  for (const ww of weekendWork) {
    anomalies.push({
      type: 'weekend_work',
      severity: ww.weekend_activities > 50 ? 'high' : 'medium',
      employee: ww.name,
      employeeId: ww.employee_id,
      count: ww.weekend_activities,
      message: `${ww.name}님이 주말 ${ww.weekend_activities}회 활동 — 업무량 검토 필요`,
    });
  }

  // 비업무 활동 과다 (게임, 쇼핑, SNS 등)
  const nonWorkApps = db.prepare(`
    SELECT employee_id, e.name, app_name,
      COUNT(*) as cnt, SUM(duration_sec) as total_sec
    FROM employee_activities ea
    JOIN employees e ON e.id = ea.employee_id
    WHERE ea.company_id = ? AND ea.timestamp > ?
      AND ea.activity_type = 'active'
      AND (ea.app_name LIKE '%game%' OR ea.url LIKE '%youtube%'
           OR ea.url LIKE '%netflix%' OR ea.url LIKE '%shopping%'
           OR ea.url LIKE '%coupang%' OR ea.url LIKE '%tiktok%'
           OR ea.url LIKE '%instagram%')
    GROUP BY employee_id, app_name
    HAVING total_sec > 3600
    ORDER BY total_sec DESC
    LIMIT 10
  `).all(companyId, since);

  for (const nw of nonWorkApps) {
    anomalies.push({
      type: 'non_work_activity',
      severity: nw.total_sec > 10800 ? 'high' : 'low',
      employee: nw.name,
      employeeId: nw.employee_id,
      app: nw.app_name,
      hours: Math.round(nw.total_sec / 3600 * 10) / 10,
      message: `${nw.name}님 — ${nw.app_name} ${Math.round(nw.total_sec / 3600)}시간 사용`,
    });
  }

  return anomalies;
}

// ── 5. 부서 간 협업 패턴 ────────────────────────────────────────────────────

function analyzeCollaboration(db, companyId) {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();

  // 같은 파일/앱을 사용하는 다른 부서 직원들
  const crossDept = db.prepare(`
    SELECT e1.department_id as dept1, d1.name as dept1_name,
           e2.department_id as dept2, d2.name as dept2_name,
           COUNT(*) as shared_activities
    FROM employee_activities ea1
    JOIN employee_activities ea2 ON ea1.app_name = ea2.app_name
      AND ea1.company_id = ea2.company_id
      AND ea1.employee_id != ea2.employee_id
      AND ABS(strftime('%s', ea1.timestamp) - strftime('%s', ea2.timestamp)) < 300
    JOIN employees e1 ON e1.id = ea1.employee_id
    JOIN employees e2 ON e2.id = ea2.employee_id
    LEFT JOIN departments d1 ON d1.id = e1.department_id
    LEFT JOIN departments d2 ON d2.id = e2.department_id
    WHERE ea1.company_id = ? AND ea1.timestamp > ?
      AND e1.department_id != e2.department_id
      AND e1.department_id < e2.department_id
    GROUP BY dept1, dept2
    HAVING shared_activities > 5
    ORDER BY shared_activities DESC
    LIMIT 20
  `).all(companyId, since);

  // 커뮤니케이션 도구 사용 패턴
  const commTools = db.prepare(`
    SELECT e.department_id, d.name as dept_name,
      SUM(CASE WHEN ea.category = 'communication' THEN ea.duration_sec ELSE 0 END) as comm_sec,
      SUM(ea.duration_sec) as total_sec
    FROM employee_activities ea
    JOIN employees e ON e.id = ea.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    WHERE ea.company_id = ? AND ea.timestamp > ?
    GROUP BY e.department_id
    ORDER BY comm_sec DESC
  `).all(companyId, since);

  return {
    crossDepartment: crossDept,
    communicationByDept: commTools.map(c => ({
      ...c,
      commRatio: c.total_sec > 0 ? Math.round(c.comm_sec / c.total_sec * 100) : 0,
    })),
  };
}

// ── 6. 프로세스 자동 매핑 ──────────────────────────────────────────────────

function autoMapProcesses(db, companyId) {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();

  // 앱 사용 패턴에서 프로세스 추론
  const appPatterns = db.prepare(`
    SELECT app_name, category,
      COUNT(DISTINCT employee_id) as users,
      COUNT(*) as frequency,
      SUM(duration_sec) as total_sec,
      AVG(duration_sec) as avg_sec,
      GROUP_CONCAT(DISTINCT SUBSTR(window_title, 1, 50)) as sample_titles
    FROM employee_activities
    WHERE company_id = ? AND timestamp > ?
      AND activity_type = 'active' AND app_name != ''
    GROUP BY app_name
    HAVING frequency > 10
    ORDER BY total_sec DESC
    LIMIT 30
  `).all(companyId, since);

  // 프로세스 후보 생성
  const candidates = appPatterns.map(p => {
    const isRepetitive = p.frequency > 50;
    const isMultiUser = p.users > 2;
    const isTimeConsuming = p.total_sec > 36000; // 10시간 이상

    let automationPotential = 0;
    if (isRepetitive) automationPotential += 0.3;
    if (p.category === 'spreadsheet') automationPotential += 0.3;
    if (p.avg_sec < 120) automationPotential += 0.2; // 짧은 반복 작업
    if (/입력|등록|전송|복사|붙여넣기/i.test(p.sample_titles || '')) automationPotential += 0.2;

    return {
      app: p.app_name,
      category: p.category,
      users: p.users,
      monthlyFrequency: p.frequency,
      monthlyHours: Math.round(p.total_sec / 3600 * 10) / 10,
      avgMinutes: Math.round(p.avg_sec / 60 * 10) / 10,
      automationPotential: Math.min(automationPotential, 1),
      sampleTitles: (p.sample_titles || '').split(',').slice(0, 5),
      flags: {
        isRepetitive,
        isMultiUser,
        isTimeConsuming,
      },
    };
  });

  return candidates.filter(c => c.automationPotential > 0.3 || c.monthlyHours > 5);
}

// ── 종합 학습 리포트 ────────────────────────────────────────────────────────

function generateCompanyLearningReport(db, companyId) {
  const ontology = require('./company-ontology');
  ontology.ensureCompanyTables(db);

  const company = ontology.getCompany(db, companyId);
  if (!company) return null;

  const patterns = analyzeWorkPatterns(db, companyId, 7);
  const bottlenecks = detectBottlenecks(db, companyId, 7);
  const opportunities = discoverAutomationOpportunities(db, companyId);
  const anomalies = detectAnomalies(db, companyId);
  const collaboration = analyzeCollaboration(db, companyId);
  const processMap = autoMapProcesses(db, companyId);

  return {
    company: { id: company.id, name: company.name },
    generatedAt: new Date().toISOString(),
    patterns,
    bottlenecks,
    automationOpportunities: opportunities,
    anomalies,
    collaboration,
    discoveredProcesses: processMap,
    summary: {
      totalBottlenecks: bottlenecks.length,
      highSeverity: bottlenecks.filter(b => b.severity === 'high').length,
      automationSavingsKrw: opportunities.reduce((s, o) => s + (o.estimatedSavingsKrw || 0), 0),
      anomalyCount: anomalies.length,
      crossDeptCollabs: collaboration.crossDepartment?.length || 0,
      discoveredProcessCount: processMap.length,
    },
  };
}

module.exports = {
  analyzeWorkPatterns,
  detectBottlenecks,
  discoverAutomationOpportunities,
  detectAnomalies,
  analyzeCollaboration,
  autoMapProcesses,
  generateCompanyLearningReport,
};
