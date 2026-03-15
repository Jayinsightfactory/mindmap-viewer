'use strict';
/**
 * src/company-ontology-pg.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Company Ontology — PostgreSQL 버전
 * company-ontology.js와 동일 인터페이스, 모든 함수 async
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { ulid } = require('ulid');

function tryParse(s) {
  if (!s || typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

// ── 테이블 생성 ─────────────────────────────────────────────────────────────
async function ensureCompanyTables(pool) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      industry TEXT DEFAULT '', industry_code TEXT DEFAULT '',
      employee_count INTEGER DEFAULT 0, revenue_range TEXT DEFAULT '',
      company_type TEXT DEFAULT 'B', consultant_id TEXT DEFAULT '',
      status TEXT DEFAULT 'bootcamp', address TEXT DEFAULT '',
      ceo_name TEXT DEFAULT '', phone TEXT DEFAULT '',
      email TEXT DEFAULT '', website TEXT DEFAULT '',
      founded_year INTEGER DEFAULT 0, fiscal_year_end TEXT DEFAULT '12',
      notes TEXT DEFAULT '', scores_json TEXT DEFAULT '{}',
      metadata_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL, head_name TEXT DEFAULT '', head_count INTEGER DEFAULT 0,
      budget_monthly REAL DEFAULT 0, key_systems TEXT DEFAULT '[]',
      pain_points TEXT DEFAULT '[]', automation_score REAL DEFAULT 0,
      efficiency_score REAL DEFAULT 0, notes TEXT DEFAULT '',
      metadata_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      department_id TEXT DEFAULT '', name TEXT NOT NULL,
      position TEXT DEFAULT '', role TEXT DEFAULT 'member',
      email TEXT DEFAULT '', phone TEXT DEFAULT '',
      hire_date TEXT DEFAULT '', skills TEXT DEFAULT '[]',
      ai_readiness REAL DEFAULT 0, workload_score REAL DEFAULT 0,
      tracker_token TEXT DEFAULT '', tracker_active INTEGER DEFAULT 0,
      last_seen_at TEXT DEFAULT '', metadata_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS processes (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      department_id TEXT DEFAULT '', name TEXT NOT NULL,
      description TEXT DEFAULT '', category TEXT DEFAULT 'general',
      frequency TEXT DEFAULT 'daily', avg_duration_min INTEGER DEFAULT 0,
      involved_people INTEGER DEFAULT 1, current_tools TEXT DEFAULT '[]',
      automation_potential REAL DEFAULT 0, automation_difficulty TEXT DEFAULT 'medium',
      bottleneck_score REAL DEFAULT 0, estimated_savings_krw INTEGER DEFAULT 0,
      estimated_savings_hrs REAL DEFAULT 0, priority_score REAL DEFAULT 0,
      status TEXT DEFAULT 'active', notes TEXT DEFAULT '',
      metadata_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS company_systems (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL, category TEXT DEFAULT 'other',
      vendor TEXT DEFAULT '', monthly_cost REAL DEFAULT 0,
      user_count INTEGER DEFAULT 0, integration_level TEXT DEFAULT 'none',
      satisfaction REAL DEFAULT 0, data_export INTEGER DEFAULT 0,
      api_available INTEGER DEFAULT 0, notes TEXT DEFAULT '',
      metadata_json TEXT DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS company_links (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL,
      from_type TEXT NOT NULL, from_id TEXT NOT NULL,
      to_type TEXT NOT NULL, to_id TEXT NOT NULL,
      link_type TEXT NOT NULL, weight REAL DEFAULT 1.0,
      label TEXT DEFAULT '', metadata_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS diagnoses (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      stage TEXT DEFAULT 'bootcamp', consultant_id TEXT DEFAULT '',
      scores_json TEXT DEFAULT '{}', findings_json TEXT DEFAULT '[]',
      recommendations_json TEXT DEFAULT '[]', roi_projection_json TEXT DEFAULT '{}',
      overall_score REAL DEFAULT 0, overall_grade TEXT DEFAULT 'F',
      summary TEXT DEFAULT '', diagnosed_at TIMESTAMPTZ DEFAULT NOW(),
      metadata_json TEXT DEFAULT '{}'
    )`,
    `CREATE TABLE IF NOT EXISTS employee_activities (
      id TEXT PRIMARY KEY, employee_id TEXT NOT NULL,
      company_id TEXT NOT NULL, tracker_token TEXT NOT NULL,
      activity_type TEXT NOT NULL, app_name TEXT DEFAULT '',
      window_title TEXT DEFAULT '', url TEXT DEFAULT '',
      category TEXT DEFAULT 'other', duration_sec INTEGER DEFAULT 0,
      keystrokes INTEGER DEFAULT 0, mouse_clicks INTEGER DEFAULT 0,
      idle_sec INTEGER DEFAULT 0, extra_json TEXT DEFAULT '{}',
      timestamp TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS benchmarks (
      id TEXT PRIMARY KEY, industry TEXT NOT NULL,
      company_type TEXT DEFAULT 'B', metric_name TEXT NOT NULL,
      avg_value REAL DEFAULT 0, top_quartile REAL DEFAULT 0,
      bottom_quartile REAL DEFAULT 0, sample_count INTEGER DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS gdrive_backup_log (
      id TEXT PRIMARY KEY, file_name TEXT NOT NULL,
      file_size INTEGER DEFAULT 0, gdrive_id TEXT DEFAULT '',
      status TEXT DEFAULT 'pending', error TEXT DEFAULT '',
      backed_up_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS bootcamp_sessions (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      consultant_id TEXT DEFAULT '', stage TEXT DEFAULT 'upload',
      uploads_json TEXT DEFAULT '[]', analysis_json TEXT DEFAULT '{}',
      findings_json TEXT DEFAULT '[]', started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TEXT DEFAULT '', status TEXT DEFAULT 'active'
    )`,
  ];

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_dept_company ON departments(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_emp_company ON employees(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_emp_dept ON employees(department_id)',
    'CREATE INDEX IF NOT EXISTS idx_emp_tracker ON employees(tracker_token)',
    'CREATE INDEX IF NOT EXISTS idx_proc_company ON processes(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_proc_dept ON processes(department_id)',
    'CREATE INDEX IF NOT EXISTS idx_sys_company ON company_systems(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_link_company ON company_links(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_link_from ON company_links(from_type, from_id)',
    'CREATE INDEX IF NOT EXISTS idx_link_to ON company_links(to_type, to_id)',
    'CREATE INDEX IF NOT EXISTS idx_diag_company ON diagnoses(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_ea_employee ON employee_activities(employee_id)',
    'CREATE INDEX IF NOT EXISTS idx_ea_company ON employee_activities(company_id)',
    'CREATE INDEX IF NOT EXISTS idx_ea_token ON employee_activities(tracker_token)',
    'CREATE INDEX IF NOT EXISTS idx_ea_timestamp ON employee_activities(timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_ea_type ON employee_activities(activity_type)',
  ];

  for (const sql of tables) await pool.query(sql);
  for (const sql of indexes) await pool.query(sql);
}

// ── Company CRUD ────────────────────────────────────────────────────────────

async function createCompany(pool, data) {
  const id = ulid();
  const type = (data.employee_count || 0) <= 30 ? 'A' : (data.employee_count || 0) <= 100 ? 'B' : 'C';
  await pool.query(`
    INSERT INTO companies (id, name, industry, industry_code, employee_count, revenue_range,
      company_type, consultant_id, status, address, ceo_name, phone, email, website,
      founded_year, notes, metadata_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [id, data.name, data.industry || '', data.industry_code || '',
     data.employee_count || 0, data.revenue_range || '', type,
     data.consultant_id || '', data.status || 'bootcamp',
     data.address || '', data.ceo_name || '', data.phone || '', data.email || '',
     data.website || '', data.founded_year || 0, data.notes || '',
     JSON.stringify(data.metadata || {})]);
  return { id, company_type: type };
}

async function getCompany(pool, id) {
  const { rows } = await pool.query('SELECT * FROM companies WHERE id = $1', [id]);
  const row = rows[0];
  if (row) { row.scores = tryParse(row.scores_json); row.metadata = tryParse(row.metadata_json); }
  return row || null;
}

async function listCompanies(pool, filter = {}) {
  let sql = 'SELECT * FROM companies WHERE 1=1';
  const params = [];
  let n = 1;
  if (filter.status) { sql += ` AND status = $${n++}`; params.push(filter.status); }
  if (filter.consultant_id) { sql += ` AND consultant_id = $${n++}`; params.push(filter.consultant_id); }
  if (filter.company_type) { sql += ` AND company_type = $${n++}`; params.push(filter.company_type); }
  sql += ' ORDER BY updated_at DESC';
  if (filter.limit) { sql += ` LIMIT $${n++}`; params.push(filter.limit); }
  const { rows } = await pool.query(sql, params);
  return rows.map(r => ({ ...r, scores: tryParse(r.scores_json), metadata: tryParse(r.metadata_json) }));
}

async function updateCompany(pool, id, data) {
  const fields = []; const params = []; let n = 1;
  const allowed = ['name','industry','industry_code','employee_count','revenue_range',
    'company_type','consultant_id','status','address','ceo_name','phone','email','website','founded_year','notes'];
  for (const f of allowed) {
    if (data[f] !== undefined) { fields.push(`${f} = $${n++}`); params.push(data[f]); }
  }
  if (data.scores) { fields.push(`scores_json = $${n++}`); params.push(JSON.stringify(data.scores)); }
  if (data.metadata) { fields.push(`metadata_json = $${n++}`); params.push(JSON.stringify(data.metadata)); }
  if (fields.length === 0) return false;
  fields.push('updated_at = NOW()');
  params.push(id);
  await pool.query(`UPDATE companies SET ${fields.join(', ')} WHERE id = $${n}`, params);
  return true;
}

async function deleteCompany(pool, id) {
  await pool.query('DELETE FROM companies WHERE id = $1', [id]);
}

// ── Department CRUD ─────────────────────────────────────────────────────────

async function createDepartment(pool, data) {
  const id = ulid();
  await pool.query(`
    INSERT INTO departments (id, company_id, name, head_name, head_count, budget_monthly,
      key_systems, pain_points, notes, metadata_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, data.company_id, data.name, data.head_name || '',
     data.head_count || 0, data.budget_monthly || 0,
     JSON.stringify(data.key_systems || []), JSON.stringify(data.pain_points || []),
     data.notes || '', JSON.stringify(data.metadata || {})]);
  return { id };
}

async function listDepartments(pool, companyId) {
  const { rows } = await pool.query('SELECT * FROM departments WHERE company_id = $1 ORDER BY name', [companyId]);
  return rows.map(r => ({ ...r, key_systems: tryParse(r.key_systems), pain_points: tryParse(r.pain_points) }));
}

async function updateDepartment(pool, id, data) {
  const fields = []; const params = []; let n = 1;
  for (const f of ['name','head_name','head_count','budget_monthly','automation_score','efficiency_score','notes']) {
    if (data[f] !== undefined) { fields.push(`${f} = $${n++}`); params.push(data[f]); }
  }
  if (data.key_systems) { fields.push(`key_systems = $${n++}`); params.push(JSON.stringify(data.key_systems)); }
  if (data.pain_points) { fields.push(`pain_points = $${n++}`); params.push(JSON.stringify(data.pain_points)); }
  if (fields.length === 0) return false;
  fields.push('updated_at = NOW()');
  params.push(id);
  await pool.query(`UPDATE departments SET ${fields.join(', ')} WHERE id = $${n}`, params);
  return true;
}

async function deleteDepartment(pool, id) {
  await pool.query('DELETE FROM departments WHERE id = $1', [id]);
}

// ── Employee CRUD ───────────────────────────────────────────────────────────

async function createEmployee(pool, data) {
  const id = ulid();
  const token = data.tracker_token || `trk_${ulid().toLowerCase()}`;
  await pool.query(`
    INSERT INTO employees (id, company_id, department_id, name, position, role, email, phone,
      hire_date, skills, tracker_token, metadata_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, data.company_id, data.department_id || '', data.name,
     data.position || '', data.role || 'member', data.email || '', data.phone || '',
     data.hire_date || '', JSON.stringify(data.skills || []), token,
     JSON.stringify(data.metadata || {})]);
  return { id, tracker_token: token };
}

async function listEmployees(pool, companyId, deptId) {
  let sql = 'SELECT * FROM employees WHERE company_id = $1';
  const params = [companyId];
  if (deptId) { sql += ' AND department_id = $2'; params.push(deptId); }
  sql += ' ORDER BY name';
  const { rows } = await pool.query(sql, params);
  return rows.map(r => ({ ...r, skills: tryParse(r.skills), metadata: tryParse(r.metadata_json) }));
}

async function getEmployeeByToken(pool, token) {
  const { rows } = await pool.query('SELECT * FROM employees WHERE tracker_token = $1', [token]);
  return rows[0] || null;
}

async function updateEmployee(pool, id, data) {
  const fields = []; const params = []; let n = 1;
  for (const f of ['name','position','role','email','phone','department_id',
    'hire_date','ai_readiness','workload_score','tracker_active','last_seen_at']) {
    if (data[f] !== undefined) { fields.push(`${f} = $${n++}`); params.push(data[f]); }
  }
  if (data.skills) { fields.push(`skills = $${n++}`); params.push(JSON.stringify(data.skills)); }
  if (fields.length === 0) return false;
  fields.push('updated_at = NOW()');
  params.push(id);
  await pool.query(`UPDATE employees SET ${fields.join(', ')} WHERE id = $${n}`, params);
  return true;
}

// ── Process CRUD ────────────────────────────────────────────────────────────

async function createProcess(pool, data) {
  const id = ulid();
  const hrs = (data.avg_duration_min || 0) / 60;
  const freqMultiplier = { daily: 22, weekly: 4, monthly: 1, quarterly: 0.33, yearly: 0.083 };
  const monthlyHrs = hrs * (freqMultiplier[data.frequency] || 1) * (data.involved_people || 1);
  const savingsHrs = monthlyHrs * (data.automation_potential || 0);
  const savingsKrw = Math.round(savingsHrs * 25000);

  await pool.query(`
    INSERT INTO processes (id, company_id, department_id, name, description, category,
      frequency, avg_duration_min, involved_people, current_tools, automation_potential,
      automation_difficulty, bottleneck_score, estimated_savings_krw, estimated_savings_hrs,
      priority_score, notes, metadata_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [id, data.company_id, data.department_id || '', data.name,
     data.description || '', data.category || 'general', data.frequency || 'daily',
     data.avg_duration_min || 0, data.involved_people || 1,
     JSON.stringify(data.current_tools || []), data.automation_potential || 0,
     data.automation_difficulty || 'medium', data.bottleneck_score || 0,
     data.estimated_savings_krw || savingsKrw, data.estimated_savings_hrs || savingsHrs,
     data.priority_score || (data.automation_potential || 0) * (data.bottleneck_score || 0),
     data.notes || '', JSON.stringify(data.metadata || {})]);
  return { id, estimated_savings_krw: savingsKrw, estimated_savings_hrs: savingsHrs };
}

async function listProcesses(pool, companyId, deptId) {
  let sql = 'SELECT * FROM processes WHERE company_id = $1';
  const params = [companyId];
  if (deptId) { sql += ' AND department_id = $2'; params.push(deptId); }
  sql += ' ORDER BY priority_score DESC';
  const { rows } = await pool.query(sql, params);
  return rows.map(r => ({ ...r, current_tools: tryParse(r.current_tools) }));
}

async function updateProcess(pool, id, data) {
  const fields = []; const params = []; let n = 1;
  for (const f of ['name','description','category','frequency','avg_duration_min',
    'involved_people','automation_potential','automation_difficulty','bottleneck_score',
    'estimated_savings_krw','estimated_savings_hrs','priority_score','status','notes']) {
    if (data[f] !== undefined) { fields.push(`${f} = $${n++}`); params.push(data[f]); }
  }
  if (data.current_tools) { fields.push(`current_tools = $${n++}`); params.push(JSON.stringify(data.current_tools)); }
  if (fields.length === 0) return false;
  fields.push('updated_at = NOW()');
  params.push(id);
  await pool.query(`UPDATE processes SET ${fields.join(', ')} WHERE id = $${n}`, params);
  return true;
}

// ── System CRUD ─────────────────────────────────────────────────────────────

async function createSystem(pool, data) {
  const id = ulid();
  await pool.query(`
    INSERT INTO company_systems (id, company_id, name, category, vendor, monthly_cost,
      user_count, integration_level, satisfaction, data_export, api_available, notes, metadata_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, data.company_id, data.name, data.category || 'other',
     data.vendor || '', data.monthly_cost || 0, data.user_count || 0,
     data.integration_level || 'none', data.satisfaction || 0,
     data.data_export ? 1 : 0, data.api_available ? 1 : 0,
     data.notes || '', JSON.stringify(data.metadata || {})]);
  return { id };
}

async function listSystems(pool, companyId) {
  const { rows } = await pool.query('SELECT * FROM company_systems WHERE company_id = $1 ORDER BY name', [companyId]);
  return rows;
}

// ── Activity ────────────────────────────────────────────────────────────────

async function insertActivity(pool, data) {
  const id = ulid();
  await pool.query(`
    INSERT INTO employee_activities (id, employee_id, company_id, tracker_token,
      activity_type, app_name, window_title, url, category, duration_sec,
      keystrokes, mouse_clicks, idle_sec, extra_json, timestamp)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, data.employee_id, data.company_id, data.tracker_token,
     data.activity_type, data.app_name || '', data.window_title || '',
     data.url || '', data.category || 'other', data.duration_sec || 0,
     data.keystrokes || 0, data.mouse_clicks || 0, data.idle_sec || 0,
     JSON.stringify(data.extra || {}), data.timestamp || new Date().toISOString()]);
  return { id };
}

async function insertActivitiesBatch(pool, activities) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const d of activities) {
      await client.query(`
        INSERT INTO employee_activities (id, employee_id, company_id, tracker_token,
          activity_type, app_name, window_title, url, category, duration_sec,
          keystrokes, mouse_clicks, idle_sec, extra_json, timestamp)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [ulid(), d.employee_id, d.company_id, d.tracker_token,
         d.activity_type, d.app_name || '', d.window_title || '',
         d.url || '', d.category || 'other', d.duration_sec || 0,
         d.keystrokes || 0, d.mouse_clicks || 0, d.idle_sec || 0,
         JSON.stringify(d.extra || {}), d.timestamp || new Date().toISOString()]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { count: activities.length };
}

async function getActivities(pool, opts = {}) {
  let sql = 'SELECT * FROM employee_activities WHERE 1=1';
  const params = []; let n = 1;
  if (opts.company_id) { sql += ` AND company_id = $${n++}`; params.push(opts.company_id); }
  if (opts.employee_id) { sql += ` AND employee_id = $${n++}`; params.push(opts.employee_id); }
  if (opts.tracker_token) { sql += ` AND tracker_token = $${n++}`; params.push(opts.tracker_token); }
  if (opts.since) { sql += ` AND timestamp > $${n++}`; params.push(opts.since); }
  if (opts.activity_type) { sql += ` AND activity_type = $${n++}`; params.push(opts.activity_type); }
  sql += ' ORDER BY timestamp DESC';
  sql += ` LIMIT ${Math.min(parseInt(opts.limit) || 100, 1000)}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function getActivityStats(pool, companyId, since) {
  const sinceDate = since || new Date(Date.now() - 86400_000).toISOString();

  const total = await pool.query(
    'SELECT COUNT(*) as cnt FROM employee_activities WHERE company_id = $1 AND timestamp > $2',
    [companyId, sinceDate]);
  const totalActivities = parseInt(total.rows[0]?.cnt) || 0;

  const byEmp = await pool.query(`
    SELECT e.name, e.department_id, ea.employee_id,
      COUNT(*) as activity_count, SUM(ea.duration_sec) as total_duration,
      SUM(ea.keystrokes) as total_keystrokes, SUM(ea.idle_sec) as total_idle
    FROM employee_activities ea JOIN employees e ON e.id = ea.employee_id
    WHERE ea.company_id = $1 AND ea.timestamp > $2
    GROUP BY ea.employee_id, e.name, e.department_id ORDER BY activity_count DESC`,
    [companyId, sinceDate]);

  const byApp = await pool.query(`
    SELECT app_name, category, COUNT(*) as usage_count, SUM(duration_sec) as total_duration
    FROM employee_activities WHERE company_id = $1 AND timestamp > $2 AND app_name != ''
    GROUP BY app_name, category ORDER BY total_duration DESC LIMIT 20`,
    [companyId, sinceDate]);

  const byCat = await pool.query(`
    SELECT category, COUNT(*) as cnt, SUM(duration_sec) as total_sec
    FROM employee_activities WHERE company_id = $1 AND timestamp > $2
    GROUP BY category ORDER BY total_sec DESC`,
    [companyId, sinceDate]);

  const activeEmp = await pool.query(
    'SELECT COUNT(DISTINCT employee_id) as cnt FROM employee_activities WHERE company_id = $1 AND timestamp > $2',
    [companyId, sinceDate]);

  return {
    totalActivities,
    activeEmployees: parseInt(activeEmp.rows[0]?.cnt) || 0,
    byEmployee: byEmp.rows,
    byApp: byApp.rows,
    byCategory: byCat.rows,
  };
}

// ── Benchmark ───────────────────────────────────────────────────────────────

async function updateBenchmark(pool, industry, companyType, metricName, value) {
  const { rows } = await pool.query(
    'SELECT * FROM benchmarks WHERE industry = $1 AND company_type = $2 AND metric_name = $3',
    [industry, companyType, metricName]);
  const existing = rows[0];

  if (existing) {
    const newAvg = (existing.avg_value * existing.sample_count + value) / (existing.sample_count + 1);
    const newTop = Math.max(existing.top_quartile, value);
    await pool.query(
      'UPDATE benchmarks SET avg_value = $1, top_quartile = $2, sample_count = sample_count + 1, updated_at = NOW() WHERE id = $3',
      [newAvg, newTop, existing.id]);
  } else {
    await pool.query(
      'INSERT INTO benchmarks (id, industry, company_type, metric_name, avg_value, top_quartile, sample_count) VALUES ($1,$2,$3,$4,$5,$6,1)',
      [ulid(), industry, companyType, metricName, value, value]);
  }
}

async function getBenchmarks(pool, industry, companyType) {
  const { rows } = await pool.query(
    'SELECT * FROM benchmarks WHERE industry = $1 AND company_type = $2 ORDER BY metric_name',
    [industry, companyType || 'B']);
  return rows;
}

// ── Graph ───────────────────────────────────────────────────────────────────

async function buildCompanyGraph(pool, companyId) {
  const company = await getCompany(pool, companyId);
  if (!company) return null;

  const departments = await listDepartments(pool, companyId);
  const employees = await listEmployees(pool, companyId);
  const processes = await listProcesses(pool, companyId);
  const systems = await listSystems(pool, companyId);
  const { rows: links } = await pool.query('SELECT * FROM company_links WHERE company_id = $1', [companyId]);

  const nodes = [];
  const edges = [];

  nodes.push({ id: `company:${company.id}`, type: 'company', label: company.name, data: company, size: 40 });

  for (const dept of departments) {
    nodes.push({ id: `dept:${dept.id}`, type: 'department', label: dept.name, data: dept, size: 15 + Math.min(dept.head_count, 30), parentId: `company:${company.id}` });
    edges.push({ source: `company:${company.id}`, target: `dept:${dept.id}`, type: 'contains' });
  }
  for (const emp of employees) {
    nodes.push({ id: `emp:${emp.id}`, type: 'employee', label: emp.name, data: emp, size: 6, parentId: emp.department_id ? `dept:${emp.department_id}` : `company:${company.id}` });
    if (emp.department_id) edges.push({ source: `dept:${emp.department_id}`, target: `emp:${emp.id}`, type: 'member_of' });
  }
  for (const proc of processes) {
    nodes.push({ id: `proc:${proc.id}`, type: 'process', label: proc.name, data: proc, size: 4 + proc.bottleneck_score * 8, parentId: proc.department_id ? `dept:${proc.department_id}` : `company:${company.id}` });
  }
  for (const sys of systems) {
    nodes.push({ id: `sys:${sys.id}`, type: 'system', label: sys.name, data: sys, size: 8 });
  }
  for (const link of links) {
    edges.push({ source: `${link.from_type}:${link.from_id}`, target: `${link.to_type}:${link.to_id}`, type: link.link_type, weight: link.weight, label: link.label });
  }

  return { company, nodes, edges, summary: { departments: departments.length, employees: employees.length, processes: processes.length, systems: systems.length, links: links.length } };
}

module.exports = {
  ensureCompanyTables,
  createCompany, getCompany, listCompanies, updateCompany, deleteCompany,
  createDepartment, listDepartments, updateDepartment, deleteDepartment,
  createEmployee, listEmployees, getEmployeeByToken, updateEmployee,
  createProcess, listProcesses, updateProcess,
  createSystem, listSystems,
  insertActivity, insertActivitiesBatch, getActivities, getActivityStats,
  updateBenchmark, getBenchmarks,
  buildCompanyGraph,
};
