'use strict';
/**
 * src/company-ontology.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Company Ontology — Palantir-style entity model for SME consulting
 *
 * Objects: Company, Department, Employee, Process, System, Issue
 * Properties: scores, metrics, cost, duration
 * Links: belongs_to, depends_on, collaborates, uses_system
 * Actions: diagnose, simulate, benchmark, alert
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { ulid } = require('ulid');

// ── 테이블 생성 ─────────────────────────────────────────────────────────────
function ensureCompanyTables(db) {
  db.exec(`
    -- ─── 고객사 ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS companies (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      industry        TEXT DEFAULT '',
      industry_code   TEXT DEFAULT '',
      employee_count  INTEGER DEFAULT 0,
      revenue_range   TEXT DEFAULT '',
      company_type    TEXT DEFAULT 'B',
      consultant_id   TEXT DEFAULT '',
      status          TEXT DEFAULT 'bootcamp',
      address         TEXT DEFAULT '',
      ceo_name        TEXT DEFAULT '',
      phone           TEXT DEFAULT '',
      email           TEXT DEFAULT '',
      website         TEXT DEFAULT '',
      founded_year    INTEGER DEFAULT 0,
      fiscal_year_end TEXT DEFAULT '12',
      notes           TEXT DEFAULT '',
      scores_json     TEXT DEFAULT '{}',
      metadata_json   TEXT DEFAULT '{}',
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    -- ─── 부서 ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS departments (
      id              TEXT PRIMARY KEY,
      company_id      TEXT NOT NULL,
      name            TEXT NOT NULL,
      head_name       TEXT DEFAULT '',
      head_count      INTEGER DEFAULT 0,
      budget_monthly  REAL DEFAULT 0,
      key_systems     TEXT DEFAULT '[]',
      pain_points     TEXT DEFAULT '[]',
      automation_score REAL DEFAULT 0,
      efficiency_score REAL DEFAULT 0,
      notes           TEXT DEFAULT '',
      metadata_json   TEXT DEFAULT '{}',
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_dept_company ON departments(company_id);

    -- ─── 직원 ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS employees (
      id              TEXT PRIMARY KEY,
      company_id      TEXT NOT NULL,
      department_id   TEXT DEFAULT '',
      name            TEXT NOT NULL,
      position        TEXT DEFAULT '',
      role            TEXT DEFAULT 'member',
      email           TEXT DEFAULT '',
      phone           TEXT DEFAULT '',
      hire_date       TEXT DEFAULT '',
      skills          TEXT DEFAULT '[]',
      ai_readiness    REAL DEFAULT 0,
      workload_score  REAL DEFAULT 0,
      tracker_token   TEXT DEFAULT '',
      tracker_active  INTEGER DEFAULT 0,
      last_seen_at    TEXT DEFAULT '',
      metadata_json   TEXT DEFAULT '{}',
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_emp_company ON employees(company_id);
    CREATE INDEX IF NOT EXISTS idx_emp_dept ON employees(department_id);
    CREATE INDEX IF NOT EXISTS idx_emp_tracker ON employees(tracker_token);

    -- ─── 프로세스 (반복 업무) ────────────────────────────────────
    CREATE TABLE IF NOT EXISTS processes (
      id                    TEXT PRIMARY KEY,
      company_id            TEXT NOT NULL,
      department_id         TEXT DEFAULT '',
      name                  TEXT NOT NULL,
      description           TEXT DEFAULT '',
      category              TEXT DEFAULT 'general',
      frequency             TEXT DEFAULT 'daily',
      avg_duration_min      INTEGER DEFAULT 0,
      involved_people       INTEGER DEFAULT 1,
      current_tools         TEXT DEFAULT '[]',
      automation_potential   REAL DEFAULT 0,
      automation_difficulty  TEXT DEFAULT 'medium',
      bottleneck_score      REAL DEFAULT 0,
      estimated_savings_krw INTEGER DEFAULT 0,
      estimated_savings_hrs REAL DEFAULT 0,
      priority_score        REAL DEFAULT 0,
      status                TEXT DEFAULT 'active',
      notes                 TEXT DEFAULT '',
      metadata_json         TEXT DEFAULT '{}',
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_proc_company ON processes(company_id);
    CREATE INDEX IF NOT EXISTS idx_proc_dept ON processes(department_id);

    -- ─── 시스템 (사용 중인 소프트웨어/도구) ─────────────────────
    CREATE TABLE IF NOT EXISTS company_systems (
      id              TEXT PRIMARY KEY,
      company_id      TEXT NOT NULL,
      name            TEXT NOT NULL,
      category        TEXT DEFAULT 'other',
      vendor          TEXT DEFAULT '',
      monthly_cost    REAL DEFAULT 0,
      user_count      INTEGER DEFAULT 0,
      integration_level TEXT DEFAULT 'none',
      satisfaction    REAL DEFAULT 0,
      data_export     INTEGER DEFAULT 0,
      api_available   INTEGER DEFAULT 0,
      notes           TEXT DEFAULT '',
      metadata_json   TEXT DEFAULT '{}',
      created_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sys_company ON company_systems(company_id);

    -- ─── 엔티티 관계 (Links) ────────────────────────────────────
    CREATE TABLE IF NOT EXISTS company_links (
      id          TEXT PRIMARY KEY,
      company_id  TEXT NOT NULL,
      from_type   TEXT NOT NULL,
      from_id     TEXT NOT NULL,
      to_type     TEXT NOT NULL,
      to_id       TEXT NOT NULL,
      link_type   TEXT NOT NULL,
      weight      REAL DEFAULT 1.0,
      label       TEXT DEFAULT '',
      metadata_json TEXT DEFAULT '{}',
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_link_company ON company_links(company_id);
    CREATE INDEX IF NOT EXISTS idx_link_from ON company_links(from_type, from_id);
    CREATE INDEX IF NOT EXISTS idx_link_to ON company_links(to_type, to_id);

    -- ─── 진단 결과 ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS diagnoses (
      id                    TEXT PRIMARY KEY,
      company_id            TEXT NOT NULL,
      stage                 TEXT DEFAULT 'bootcamp',
      consultant_id         TEXT DEFAULT '',
      scores_json           TEXT DEFAULT '{}',
      findings_json         TEXT DEFAULT '[]',
      recommendations_json  TEXT DEFAULT '[]',
      roi_projection_json   TEXT DEFAULT '{}',
      overall_score         REAL DEFAULT 0,
      overall_grade         TEXT DEFAULT 'F',
      summary               TEXT DEFAULT '',
      diagnosed_at          TEXT DEFAULT (datetime('now')),
      metadata_json         TEXT DEFAULT '{}',
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_diag_company ON diagnoses(company_id);

    -- ─── 직원 활동 추적 데이터 ──────────────────────────────────
    CREATE TABLE IF NOT EXISTS employee_activities (
      id              TEXT PRIMARY KEY,
      employee_id     TEXT NOT NULL,
      company_id      TEXT NOT NULL,
      tracker_token   TEXT NOT NULL,
      activity_type   TEXT NOT NULL,
      app_name        TEXT DEFAULT '',
      window_title    TEXT DEFAULT '',
      url             TEXT DEFAULT '',
      category        TEXT DEFAULT 'other',
      duration_sec    INTEGER DEFAULT 0,
      keystrokes      INTEGER DEFAULT 0,
      mouse_clicks    INTEGER DEFAULT 0,
      idle_sec        INTEGER DEFAULT 0,
      extra_json      TEXT DEFAULT '{}',
      timestamp       TEXT NOT NULL,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ea_employee ON employee_activities(employee_id);
    CREATE INDEX IF NOT EXISTS idx_ea_company ON employee_activities(company_id);
    CREATE INDEX IF NOT EXISTS idx_ea_token ON employee_activities(tracker_token);
    CREATE INDEX IF NOT EXISTS idx_ea_timestamp ON employee_activities(timestamp);
    CREATE INDEX IF NOT EXISTS idx_ea_type ON employee_activities(activity_type);

    -- ─── 벤치마크 / 업종 평균 ───────────────────────────────────
    CREATE TABLE IF NOT EXISTS benchmarks (
      id              TEXT PRIMARY KEY,
      industry        TEXT NOT NULL,
      company_type    TEXT DEFAULT 'B',
      metric_name     TEXT NOT NULL,
      avg_value       REAL DEFAULT 0,
      top_quartile    REAL DEFAULT 0,
      bottom_quartile REAL DEFAULT 0,
      sample_count    INTEGER DEFAULT 0,
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bench_unique ON benchmarks(industry, company_type, metric_name);

    -- ─── Google Drive 백업 로그 ──────────────────────────────────
    CREATE TABLE IF NOT EXISTS gdrive_backup_log (
      id          TEXT PRIMARY KEY,
      file_name   TEXT NOT NULL,
      file_size   INTEGER DEFAULT 0,
      gdrive_id   TEXT DEFAULT '',
      status      TEXT DEFAULT 'pending',
      error       TEXT DEFAULT '',
      backed_up_at TEXT DEFAULT (datetime('now'))
    );

    -- ─── 부트캠프 세션 ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS bootcamp_sessions (
      id              TEXT PRIMARY KEY,
      company_id      TEXT NOT NULL,
      consultant_id   TEXT DEFAULT '',
      stage           TEXT DEFAULT 'upload',
      uploads_json    TEXT DEFAULT '[]',
      analysis_json   TEXT DEFAULT '{}',
      findings_json   TEXT DEFAULT '[]',
      started_at      TEXT DEFAULT (datetime('now')),
      completed_at    TEXT DEFAULT '',
      status          TEXT DEFAULT 'active',
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
  `);
}

// ── CRUD 헬퍼 ────────────────────────────────────────────────────────────────

function createCompany(db, data) {
  const id = ulid();
  const type = (data.employee_count || 0) <= 30 ? 'A'
             : (data.employee_count || 0) <= 100 ? 'B' : 'C';
  db.prepare(`
    INSERT INTO companies (id, name, industry, industry_code, employee_count, revenue_range,
      company_type, consultant_id, status, address, ceo_name, phone, email, website,
      founded_year, notes, metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, data.name, data.industry || '', data.industry_code || '',
    data.employee_count || 0, data.revenue_range || '', type,
    data.consultant_id || '', data.status || 'bootcamp',
    data.address || '', data.ceo_name || '', data.phone || '', data.email || '',
    data.website || '', data.founded_year || 0, data.notes || '',
    JSON.stringify(data.metadata || {}));
  return { id, company_type: type };
}

function getCompany(db, id) {
  const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (row) {
    row.scores = tryParse(row.scores_json);
    row.metadata = tryParse(row.metadata_json);
  }
  return row;
}

function listCompanies(db, filter = {}) {
  let sql = 'SELECT * FROM companies WHERE 1=1';
  const params = [];
  if (filter.status) { sql += ' AND status = ?'; params.push(filter.status); }
  if (filter.consultant_id) { sql += ' AND consultant_id = ?'; params.push(filter.consultant_id); }
  if (filter.company_type) { sql += ' AND company_type = ?'; params.push(filter.company_type); }
  sql += ' ORDER BY updated_at DESC';
  if (filter.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }
  return db.prepare(sql).all(...params).map(r => ({
    ...r, scores: tryParse(r.scores_json), metadata: tryParse(r.metadata_json)
  }));
}

function updateCompany(db, id, data) {
  const fields = [];
  const params = [];
  const allowed = ['name','industry','industry_code','employee_count','revenue_range',
    'company_type','consultant_id','status','address','ceo_name','phone','email',
    'website','founded_year','notes'];
  for (const f of allowed) {
    if (data[f] !== undefined) { fields.push(`${f} = ?`); params.push(data[f]); }
  }
  if (data.scores) { fields.push('scores_json = ?'); params.push(JSON.stringify(data.scores)); }
  if (data.metadata) { fields.push('metadata_json = ?'); params.push(JSON.stringify(data.metadata)); }
  if (fields.length === 0) return false;
  fields.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE companies SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return true;
}

function deleteCompany(db, id) {
  db.prepare('DELETE FROM companies WHERE id = ?').run(id);
}

// ── 부서 CRUD ────────────────────────────────────────────────────────────────

function createDepartment(db, data) {
  const id = ulid();
  db.prepare(`
    INSERT INTO departments (id, company_id, name, head_name, head_count, budget_monthly,
      key_systems, pain_points, notes, metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(id, data.company_id, data.name, data.head_name || '',
    data.head_count || 0, data.budget_monthly || 0,
    JSON.stringify(data.key_systems || []), JSON.stringify(data.pain_points || []),
    data.notes || '', JSON.stringify(data.metadata || {}));
  return { id };
}

function listDepartments(db, companyId) {
  return db.prepare('SELECT * FROM departments WHERE company_id = ? ORDER BY name').all(companyId)
    .map(r => ({ ...r, key_systems: tryParse(r.key_systems), pain_points: tryParse(r.pain_points) }));
}

function updateDepartment(db, id, data) {
  const fields = [];
  const params = [];
  for (const f of ['name','head_name','head_count','budget_monthly','automation_score','efficiency_score','notes']) {
    if (data[f] !== undefined) { fields.push(`${f} = ?`); params.push(data[f]); }
  }
  if (data.key_systems) { fields.push('key_systems = ?'); params.push(JSON.stringify(data.key_systems)); }
  if (data.pain_points) { fields.push('pain_points = ?'); params.push(JSON.stringify(data.pain_points)); }
  if (fields.length === 0) return false;
  fields.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE departments SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return true;
}

function deleteDepartment(db, id) {
  db.prepare('DELETE FROM departments WHERE id = ?').run(id);
}

// ── 직원 CRUD ────────────────────────────────────────────────────────────────

function createEmployee(db, data) {
  const id = ulid();
  // 자동 트래커 토큰 생성 (로그인 없이 설치만 하면 동작)
  const token = data.tracker_token || `trk_${ulid().toLowerCase()}`;
  db.prepare(`
    INSERT INTO employees (id, company_id, department_id, name, position, role, email, phone,
      hire_date, skills, tracker_token, metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, data.company_id, data.department_id || '', data.name,
    data.position || '', data.role || 'member', data.email || '', data.phone || '',
    data.hire_date || '', JSON.stringify(data.skills || []), token,
    JSON.stringify(data.metadata || {}));
  return { id, tracker_token: token };
}

function listEmployees(db, companyId, deptId) {
  let sql = 'SELECT * FROM employees WHERE company_id = ?';
  const params = [companyId];
  if (deptId) { sql += ' AND department_id = ?'; params.push(deptId); }
  sql += ' ORDER BY name';
  return db.prepare(sql).all(...params).map(r => ({
    ...r, skills: tryParse(r.skills), metadata: tryParse(r.metadata_json)
  }));
}

function getEmployeeByToken(db, token) {
  return db.prepare('SELECT * FROM employees WHERE tracker_token = ?').get(token);
}

function updateEmployee(db, id, data) {
  const fields = [];
  const params = [];
  for (const f of ['name','position','role','email','phone','department_id',
    'hire_date','ai_readiness','workload_score','tracker_active','last_seen_at']) {
    if (data[f] !== undefined) { fields.push(`${f} = ?`); params.push(data[f]); }
  }
  if (data.skills) { fields.push('skills = ?'); params.push(JSON.stringify(data.skills)); }
  if (fields.length === 0) return false;
  fields.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return true;
}

// ── 프로세스 CRUD ────────────────────────────────────────────────────────────

function createProcess(db, data) {
  const id = ulid();
  // 자동화 절감액 추정 (시간 * 인건비)
  const hrs = (data.avg_duration_min || 0) / 60;
  const freqMultiplier = { daily: 22, weekly: 4, monthly: 1, quarterly: 0.33, yearly: 0.083 };
  const monthlyHrs = hrs * (freqMultiplier[data.frequency] || 1) * (data.involved_people || 1);
  const savingsHrs = monthlyHrs * (data.automation_potential || 0);
  const savingsKrw = Math.round(savingsHrs * 25000); // 시급 25,000원 기준

  db.prepare(`
    INSERT INTO processes (id, company_id, department_id, name, description, category,
      frequency, avg_duration_min, involved_people, current_tools, automation_potential,
      automation_difficulty, bottleneck_score, estimated_savings_krw, estimated_savings_hrs,
      priority_score, notes, metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, data.company_id, data.department_id || '', data.name,
    data.description || '', data.category || 'general', data.frequency || 'daily',
    data.avg_duration_min || 0, data.involved_people || 1,
    JSON.stringify(data.current_tools || []), data.automation_potential || 0,
    data.automation_difficulty || 'medium', data.bottleneck_score || 0,
    data.estimated_savings_krw || savingsKrw, data.estimated_savings_hrs || savingsHrs,
    data.priority_score || (data.automation_potential || 0) * (data.bottleneck_score || 0),
    data.notes || '', JSON.stringify(data.metadata || {}));
  return { id, estimated_savings_krw: savingsKrw, estimated_savings_hrs: savingsHrs };
}

function listProcesses(db, companyId, deptId) {
  let sql = 'SELECT * FROM processes WHERE company_id = ?';
  const params = [companyId];
  if (deptId) { sql += ' AND department_id = ?'; params.push(deptId); }
  sql += ' ORDER BY priority_score DESC';
  return db.prepare(sql).all(...params).map(r => ({
    ...r, current_tools: tryParse(r.current_tools)
  }));
}

function updateProcess(db, id, data) {
  const fields = [];
  const params = [];
  for (const f of ['name','description','category','frequency','avg_duration_min',
    'involved_people','automation_potential','automation_difficulty','bottleneck_score',
    'estimated_savings_krw','estimated_savings_hrs','priority_score','status','notes']) {
    if (data[f] !== undefined) { fields.push(`${f} = ?`); params.push(data[f]); }
  }
  if (data.current_tools) { fields.push('current_tools = ?'); params.push(JSON.stringify(data.current_tools)); }
  if (fields.length === 0) return false;
  fields.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE processes SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return true;
}

// ── 시스템 CRUD ──────────────────────────────────────────────────────────────

function createSystem(db, data) {
  const id = ulid();
  db.prepare(`
    INSERT INTO company_systems (id, company_id, name, category, vendor, monthly_cost,
      user_count, integration_level, satisfaction, data_export, api_available, notes, metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, data.company_id, data.name, data.category || 'other',
    data.vendor || '', data.monthly_cost || 0, data.user_count || 0,
    data.integration_level || 'none', data.satisfaction || 0,
    data.data_export ? 1 : 0, data.api_available ? 1 : 0,
    data.notes || '', JSON.stringify(data.metadata || {}));
  return { id };
}

function listSystems(db, companyId) {
  return db.prepare('SELECT * FROM company_systems WHERE company_id = ? ORDER BY name').all(companyId);
}

// ── 활동 데이터 저장 (직원 트래커에서 수신) ─────────────────────────────────

function insertActivity(db, data) {
  const id = ulid();
  db.prepare(`
    INSERT INTO employee_activities (id, employee_id, company_id, tracker_token,
      activity_type, app_name, window_title, url, category, duration_sec,
      keystrokes, mouse_clicks, idle_sec, extra_json, timestamp)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, data.employee_id, data.company_id, data.tracker_token,
    data.activity_type, data.app_name || '', data.window_title || '',
    data.url || '', data.category || 'other', data.duration_sec || 0,
    data.keystrokes || 0, data.mouse_clicks || 0, data.idle_sec || 0,
    JSON.stringify(data.extra || {}), data.timestamp || new Date().toISOString());
  return { id };
}

function insertActivitiesBatch(db, activities) {
  const stmt = db.prepare(`
    INSERT INTO employee_activities (id, employee_id, company_id, tracker_token,
      activity_type, app_name, window_title, url, category, duration_sec,
      keystrokes, mouse_clicks, idle_sec, extra_json, timestamp)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const tx = db.transaction((items) => {
    for (const d of items) {
      stmt.run(ulid(), d.employee_id, d.company_id, d.tracker_token,
        d.activity_type, d.app_name || '', d.window_title || '',
        d.url || '', d.category || 'other', d.duration_sec || 0,
        d.keystrokes || 0, d.mouse_clicks || 0, d.idle_sec || 0,
        JSON.stringify(d.extra || {}), d.timestamp || new Date().toISOString());
    }
  });
  tx(activities);
  return { count: activities.length };
}

function getActivities(db, opts = {}) {
  let sql = 'SELECT * FROM employee_activities WHERE 1=1';
  const params = [];
  if (opts.company_id) { sql += ' AND company_id = ?'; params.push(opts.company_id); }
  if (opts.employee_id) { sql += ' AND employee_id = ?'; params.push(opts.employee_id); }
  if (opts.tracker_token) { sql += ' AND tracker_token = ?'; params.push(opts.tracker_token); }
  if (opts.since) { sql += ' AND timestamp > ?'; params.push(opts.since); }
  if (opts.activity_type) { sql += ' AND activity_type = ?'; params.push(opts.activity_type); }
  sql += ' ORDER BY timestamp DESC';
  sql += ` LIMIT ${Math.min(parseInt(opts.limit) || 100, 1000)}`;
  return db.prepare(sql).all(...params);
}

function getActivityStats(db, companyId, since) {
  const sinceDate = since || new Date(Date.now() - 86400_000).toISOString();

  const totalActivities = db.prepare(
    'SELECT COUNT(*) as cnt FROM employee_activities WHERE company_id = ? AND timestamp > ?'
  ).get(companyId, sinceDate)?.cnt || 0;

  const byEmployee = db.prepare(`
    SELECT e.name, e.department_id, ea.employee_id,
      COUNT(*) as activity_count,
      SUM(ea.duration_sec) as total_duration,
      SUM(ea.keystrokes) as total_keystrokes,
      SUM(ea.idle_sec) as total_idle
    FROM employee_activities ea
    JOIN employees e ON e.id = ea.employee_id
    WHERE ea.company_id = ? AND ea.timestamp > ?
    GROUP BY ea.employee_id
    ORDER BY activity_count DESC
  `).all(companyId, sinceDate);

  const byApp = db.prepare(`
    SELECT app_name, category,
      COUNT(*) as usage_count,
      SUM(duration_sec) as total_duration
    FROM employee_activities
    WHERE company_id = ? AND timestamp > ? AND app_name != ''
    GROUP BY app_name
    ORDER BY total_duration DESC
    LIMIT 20
  `).all(companyId, sinceDate);

  const byCategory = db.prepare(`
    SELECT category, COUNT(*) as cnt, SUM(duration_sec) as total_sec
    FROM employee_activities
    WHERE company_id = ? AND timestamp > ?
    GROUP BY category
    ORDER BY total_sec DESC
  `).all(companyId, sinceDate);

  const activeEmployees = db.prepare(`
    SELECT COUNT(DISTINCT employee_id) as cnt
    FROM employee_activities
    WHERE company_id = ? AND timestamp > ?
  `).get(companyId, sinceDate)?.cnt || 0;

  return { totalActivities, activeEmployees, byEmployee, byApp, byCategory };
}

// ── 벤치마크 ────────────────────────────────────────────────────────────────

function updateBenchmark(db, industry, companyType, metricName, value) {
  const existing = db.prepare(
    'SELECT * FROM benchmarks WHERE industry = ? AND company_type = ? AND metric_name = ?'
  ).get(industry, companyType, metricName);

  if (existing) {
    const newAvg = (existing.avg_value * existing.sample_count + value) / (existing.sample_count + 1);
    const newTop = Math.max(existing.top_quartile, value);
    db.prepare(`
      UPDATE benchmarks SET avg_value = ?, top_quartile = ?, sample_count = sample_count + 1,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(newAvg, newTop, existing.id);
  } else {
    db.prepare(`
      INSERT INTO benchmarks (id, industry, company_type, metric_name, avg_value, top_quartile, sample_count)
      VALUES (?,?,?,?,?,?,1)
    `).run(ulid(), industry, companyType, metricName, value, value);
  }
}

function getBenchmarks(db, industry, companyType) {
  return db.prepare(
    'SELECT * FROM benchmarks WHERE industry = ? AND company_type = ? ORDER BY metric_name'
  ).all(industry, companyType || 'B');
}

// ── 회사 온톨로지 그래프 빌드 ────────────────────────────────────────────────

function buildCompanyGraph(db, companyId) {
  const company = getCompany(db, companyId);
  if (!company) return null;

  const departments = listDepartments(db, companyId);
  const employees = listEmployees(db, companyId);
  const processes = listProcesses(db, companyId);
  const systems = listSystems(db, companyId);
  const links = db.prepare('SELECT * FROM company_links WHERE company_id = ?').all(companyId);

  const nodes = [];
  const edges = [];

  // Company node (Sun)
  nodes.push({
    id: `company:${company.id}`,
    type: 'company',
    label: company.name,
    data: company,
    size: 40,
  });

  // Department nodes (Planets)
  for (const dept of departments) {
    nodes.push({
      id: `dept:${dept.id}`,
      type: 'department',
      label: dept.name,
      data: dept,
      size: 15 + Math.min(dept.head_count, 30),
      parentId: `company:${company.id}`,
    });
    edges.push({
      source: `company:${company.id}`,
      target: `dept:${dept.id}`,
      type: 'contains',
    });
  }

  // Employee nodes
  for (const emp of employees) {
    nodes.push({
      id: `emp:${emp.id}`,
      type: 'employee',
      label: emp.name,
      data: emp,
      size: 6,
      parentId: emp.department_id ? `dept:${emp.department_id}` : `company:${company.id}`,
    });
    if (emp.department_id) {
      edges.push({
        source: `dept:${emp.department_id}`,
        target: `emp:${emp.id}`,
        type: 'member_of',
      });
    }
  }

  // Process nodes (Satellites)
  for (const proc of processes) {
    nodes.push({
      id: `proc:${proc.id}`,
      type: 'process',
      label: proc.name,
      data: proc,
      size: 4 + proc.bottleneck_score * 8,
      parentId: proc.department_id ? `dept:${proc.department_id}` : `company:${company.id}`,
    });
  }

  // System nodes
  for (const sys of systems) {
    nodes.push({
      id: `sys:${sys.id}`,
      type: 'system',
      label: sys.name,
      data: sys,
      size: 8,
    });
  }

  // Custom links
  for (const link of links) {
    edges.push({
      source: `${link.from_type}:${link.from_id}`,
      target: `${link.to_type}:${link.to_id}`,
      type: link.link_type,
      weight: link.weight,
      label: link.label,
    });
  }

  return {
    company,
    nodes,
    edges,
    summary: {
      departments: departments.length,
      employees: employees.length,
      processes: processes.length,
      systems: systems.length,
      links: links.length,
    },
  };
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────

function tryParse(s) {
  if (!s || typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

module.exports = {
  ensureCompanyTables,
  // Company
  createCompany, getCompany, listCompanies, updateCompany, deleteCompany,
  // Department
  createDepartment, listDepartments, updateDepartment, deleteDepartment,
  // Employee
  createEmployee, listEmployees, getEmployeeByToken, updateEmployee,
  // Process
  createProcess, listProcesses, updateProcess,
  // System
  createSystem, listSystems,
  // Activity
  insertActivity, insertActivitiesBatch, getActivities, getActivityStats,
  // Benchmark
  updateBenchmark, getBenchmarks,
  // Graph
  buildCompanyGraph,
};
