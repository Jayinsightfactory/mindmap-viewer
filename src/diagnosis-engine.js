'use strict';
/**
 * src/diagnosis-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 중소기업 진단 엔진 — 6개 영역 자동 점수 계산 + AI 분석
 *
 * 영역:
 *   1. 업무 디지털화 수준 (digitalization)
 *   2. 프로세스 효율성 (processEfficiency)
 *   3. 데이터 활용도 (dataUtilization)
 *   4. 인력 역량 (humanCapability)
 *   5. 비용 구조 (costStructure)
 *   6. 성장 잠재력 (growthPotential)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { ulid } = require('ulid');

// ── 6개 영역 점수 계산 ──────────────────────────────────────────────────────

function scoreDigitalization(companyData) {
  const { systems = [], processes = [], activities = [] } = companyData;
  let score = 0;
  const findings = [];

  // 시스템 수 (ERP, CRM 등)
  const sysCount = systems.length;
  score += Math.min(sysCount * 8, 30);
  if (sysCount === 0) findings.push({ severity: 'high', msg: '사용 중인 IT 시스템이 없습니다.' });
  else if (sysCount >= 3) findings.push({ severity: 'good', msg: `${sysCount}개 시스템을 활용 중입니다.` });

  // API/데이터 연동 가능 시스템 비율
  const apiSys = systems.filter(s => s.api_available).length;
  const apiRatio = sysCount > 0 ? apiSys / sysCount : 0;
  score += Math.round(apiRatio * 20);
  if (apiRatio < 0.3 && sysCount > 0) findings.push({ severity: 'medium', msg: '시스템 간 데이터 연동이 부족합니다.' });

  // 프로세스 디지털화 (현재 도구에 '엑셀'만 있는 비율)
  const excelOnly = processes.filter(p => {
    const tools = Array.isArray(p.current_tools) ? p.current_tools : [];
    return tools.length > 0 && tools.every(t => /엑셀|excel|수기|수작업/i.test(t));
  }).length;
  const excelRatio = processes.length > 0 ? excelOnly / processes.length : 0;
  score += Math.round((1 - excelRatio) * 30);
  if (excelRatio > 0.5) findings.push({ severity: 'high', msg: `프로세스의 ${Math.round(excelRatio * 100)}%가 엑셀/수작업에 의존합니다.` });

  // 트래커 활동 다양성
  const uniqueApps = new Set(activities.map(a => a.app_name).filter(Boolean));
  score += Math.min(uniqueApps.size * 2, 20);
  if (uniqueApps.size > 5) findings.push({ severity: 'good', msg: `직원들이 ${uniqueApps.size}개 앱을 활용 중입니다.` });

  return { score: Math.min(Math.round(score), 100), findings };
}

function scoreProcessEfficiency(companyData) {
  const { processes = [], activities = [] } = companyData;
  let score = 50; // 기본 중간 점수
  const findings = [];

  if (processes.length === 0) {
    return { score: 0, findings: [{ severity: 'high', msg: '프로세스 데이터가 없습니다. 업무 매핑이 필요합니다.' }] };
  }

  // 병목 점수 평균
  const avgBottleneck = processes.reduce((s, p) => s + (p.bottleneck_score || 0), 0) / processes.length;
  score -= Math.round(avgBottleneck * 30); // 병목 높을수록 감점
  if (avgBottleneck > 0.6) findings.push({ severity: 'high', msg: '평균 병목 점수가 높습니다. 프로세스 개선이 시급합니다.' });

  // 자동화 가능성 vs 현재 자동화 수준
  const avgAutoPotential = processes.reduce((s, p) => s + (p.automation_potential || 0), 0) / processes.length;
  const unrealizedAuto = avgAutoPotential * 100;
  score += Math.round((1 - avgAutoPotential) * 20); // 이미 자동화된 게 많으면 가산
  if (unrealizedAuto > 60) findings.push({ severity: 'medium', msg: `자동화 가능 업무의 ${Math.round(unrealizedAuto)}%가 미적용 상태입니다.` });

  // 빈도 높은 수작업 프로세스
  const highFreqManual = processes.filter(p =>
    (p.frequency === 'daily' || p.frequency === 'weekly') && p.automation_potential > 0.5
  );
  if (highFreqManual.length > 0) {
    score -= highFreqManual.length * 5;
    findings.push({
      severity: 'high',
      msg: `${highFreqManual.length}개의 고빈도 수작업 프로세스가 있습니다: ${highFreqManual.map(p => p.name).join(', ')}`
    });
  }

  // 활동 데이터 기반: 유휴 시간 비율
  if (activities.length > 0) {
    const totalDuration = activities.reduce((s, a) => s + (a.duration_sec || 0), 0);
    const totalIdle = activities.reduce((s, a) => s + (a.idle_sec || 0), 0);
    const idleRatio = totalDuration > 0 ? totalIdle / totalDuration : 0;
    if (idleRatio > 0.3) {
      score -= 10;
      findings.push({ severity: 'medium', msg: `평균 유휴 시간이 ${Math.round(idleRatio * 100)}%입니다.` });
    }
  }

  return { score: Math.max(0, Math.min(Math.round(score), 100)), findings };
}

function scoreDataUtilization(companyData) {
  const { systems = [], activities = [] } = companyData;
  let score = 0;
  const findings = [];

  // 데이터 내보내기 가능 시스템
  const exportable = systems.filter(s => s.data_export).length;
  score += Math.min(exportable * 15, 30);

  // 시스템 통합 수준
  const integrated = systems.filter(s => s.integration_level === 'full' || s.integration_level === 'partial').length;
  const intRatio = systems.length > 0 ? integrated / systems.length : 0;
  score += Math.round(intRatio * 30);
  if (intRatio < 0.3 && systems.length > 2) {
    findings.push({ severity: 'high', msg: '시스템 간 데이터 사일로가 존재합니다.' });
  }

  // 데이터 관련 앱 사용 (BI, 분석도구 등)
  const dataApps = activities.filter(a =>
    /excel|sheets|power ?bi|tableau|looker|metabase|redash|노션|notion/i.test(a.app_name || '')
  );
  score += Math.min(dataApps.length, 40);
  if (dataApps.length > 10) findings.push({ severity: 'good', msg: '데이터 분석 도구를 활발히 사용 중입니다.' });
  else if (dataApps.length === 0) findings.push({ severity: 'medium', msg: '데이터 분석 도구 사용이 감지되지 않습니다.' });

  return { score: Math.min(Math.round(score), 100), findings };
}

function scoreHumanCapability(companyData) {
  const { employees = [], activities = [] } = companyData;
  let score = 30;
  const findings = [];

  if (employees.length === 0) {
    return { score: 0, findings: [{ severity: 'medium', msg: '직원 데이터가 필요합니다.' }] };
  }

  // AI 도구 사용 직원 비율
  const aiApps = /chatgpt|claude|copilot|bard|gemini|midjourney|dalle|cursor|windsurf/i;
  const employeeAiMap = new Map();
  for (const act of activities) {
    if (aiApps.test(act.app_name || '') || aiApps.test(act.window_title || '')) {
      employeeAiMap.set(act.employee_id, true);
    }
  }
  const aiUserRatio = employees.length > 0 ? employeeAiMap.size / employees.length : 0;
  score += Math.round(aiUserRatio * 40);
  if (aiUserRatio > 0.3) findings.push({ severity: 'good', msg: `직원의 ${Math.round(aiUserRatio * 100)}%가 AI 도구를 사용합니다.` });
  else findings.push({ severity: 'medium', msg: 'AI 도구 활용이 부족합니다. 교육이 필요합니다.' });

  // 트래커 활성 직원 비율
  const activeTrackers = employees.filter(e => e.tracker_active).length;
  score += Math.round((activeTrackers / employees.length) * 15);

  // 평균 AI 준비도
  const avgReadiness = employees.reduce((s, e) => s + (e.ai_readiness || 0), 0) / employees.length;
  score += Math.round(avgReadiness * 15);

  return { score: Math.min(Math.round(score), 100), findings };
}

function scoreCostStructure(companyData) {
  const { processes = [], systems = [], departments = [] } = companyData;
  let score = 50;
  const findings = [];

  // 총 자동화 절감 가능액
  const totalSavingsKrw = processes.reduce((s, p) => s + (p.estimated_savings_krw || 0), 0);
  const totalSavingsHrs = processes.reduce((s, p) => s + (p.estimated_savings_hrs || 0), 0);

  if (totalSavingsKrw > 5000000) {
    findings.push({ severity: 'high', msg: `월 ${(totalSavingsKrw / 10000).toFixed(0)}만원의 절감 가능액이 있습니다.` });
    score -= 20; // 절감 가능 = 현재 비효율적
  } else if (totalSavingsKrw > 0) {
    findings.push({ severity: 'medium', msg: `월 ${(totalSavingsKrw / 10000).toFixed(0)}만원 절감 가능합니다.` });
  }

  // 시스템 비용 대비 만족도
  const totalSystemCost = systems.reduce((s, sys) => s + (sys.monthly_cost || 0), 0);
  const avgSatisfaction = systems.length > 0
    ? systems.reduce((s, sys) => s + (sys.satisfaction || 0), 0) / systems.length
    : 0;
  if (totalSystemCost > 0 && avgSatisfaction < 3) {
    score -= 10;
    findings.push({ severity: 'medium', msg: `월 ${totalSystemCost.toLocaleString()}원의 시스템 비용 대비 만족도가 낮습니다.` });
  }

  // 인건비 중 반복 작업 비율
  const totalBudget = departments.reduce((s, d) => s + (d.budget_monthly || 0), 0);
  if (totalBudget > 0 && totalSavingsKrw > 0) {
    const wasteRatio = totalSavingsKrw / totalBudget;
    if (wasteRatio > 0.1) {
      score -= 15;
      findings.push({ severity: 'high', msg: `인건비의 ${Math.round(wasteRatio * 100)}%가 자동화 가능한 반복 업무에 소모됩니다.` });
    }
  }

  return {
    score: Math.max(0, Math.min(Math.round(score), 100)),
    findings,
    meta: { totalSavingsKrw, totalSavingsHrs, totalSystemCost }
  };
}

function scoreGrowthPotential(companyData) {
  const { company, systems = [], processes = [], employees = [] } = companyData;
  let score = 40;
  const findings = [];

  // 자동화 준비도 (잠재력이 높다 = 성장 가능)
  const highPotential = processes.filter(p => (p.automation_potential || 0) > 0.6);
  score += Math.min(highPotential.length * 5, 25);
  if (highPotential.length > 3) {
    findings.push({ severity: 'good', msg: `${highPotential.length}개 프로세스에서 높은 자동화 잠재력을 보입니다.` });
  }

  // API 연동 가능 시스템 (확장 가능성)
  const apiReady = systems.filter(s => s.api_available).length;
  score += Math.min(apiReady * 5, 15);

  // 직원 수 대비 시스템 비율
  const empCount = company?.employee_count || employees.length;
  if (empCount > 0 && systems.length > 0) {
    const sysPerEmp = systems.length / empCount;
    if (sysPerEmp < 0.1) findings.push({ severity: 'medium', msg: '직원 대비 IT 시스템이 부족합니다.' });
  }

  // 업종 성장 가능성 (추후 벤치마크 DB 연동)
  score += 10; // 기본 가산

  return { score: Math.min(Math.round(score), 100), findings };
}

// ── 종합 진단 실행 ──────────────────────────────────────────────────────────

function runDiagnosis(db, companyId, stage = 'bootcamp') {
  const ontology = require('./company-ontology');
  const company = ontology.getCompany(db, companyId);
  if (!company) return null;

  const departments = ontology.listDepartments(db, companyId);
  const employees = ontology.listEmployees(db, companyId);
  const processes = ontology.listProcesses(db, companyId);
  const systems = ontology.listSystems(db, companyId);

  // 최근 7일 활동 데이터
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const activities = ontology.getActivities(db, { company_id: companyId, since, limit: 1000 });

  const data = { company, departments, employees, processes, systems, activities };

  // 6개 영역 점수 계산
  const scores = {
    digitalization:    scoreDigitalization(data),
    processEfficiency: scoreProcessEfficiency(data),
    dataUtilization:   scoreDataUtilization(data),
    humanCapability:   scoreHumanCapability(data),
    costStructure:     scoreCostStructure(data),
    growthPotential:   scoreGrowthPotential(data),
  };

  // 종합 점수
  const weights = { digitalization: 0.2, processEfficiency: 0.25, dataUtilization: 0.15,
    humanCapability: 0.15, costStructure: 0.15, growthPotential: 0.1 };
  let overall = 0;
  for (const [key, weight] of Object.entries(weights)) {
    overall += (scores[key]?.score || 0) * weight;
  }
  overall = Math.round(overall);

  // 등급
  const grade = overall >= 80 ? 'A' : overall >= 60 ? 'B' : overall >= 40 ? 'C' : overall >= 20 ? 'D' : 'F';

  // 모든 findings 수집
  const allFindings = [];
  for (const [area, result] of Object.entries(scores)) {
    for (const f of result.findings || []) {
      allFindings.push({ area, ...f });
    }
  }

  // 자동 추천 생성
  const recommendations = generateRecommendations(scores, data);

  // ROI 예측
  const totalSavingsKrw = processes.reduce((s, p) => s + (p.estimated_savings_krw || 0), 0);
  const roiProjection = {
    monthlyPotentialSavings: totalSavingsKrw,
    yearlyPotentialSavings: totalSavingsKrw * 12,
    implementationCostEstimate: totalSavingsKrw * 3,  // 3개월치 투자
    breakEvenMonths: totalSavingsKrw > 0 ? Math.ceil((totalSavingsKrw * 3) / totalSavingsKrw) : 0,
    threeYearROI: totalSavingsKrw > 0 ? Math.round(((totalSavingsKrw * 36 - totalSavingsKrw * 3) / (totalSavingsKrw * 3)) * 100) : 0,
  };

  // DB에 진단 결과 저장
  const diagId = ulid();
  const summary = `${company.name} ${stage} 진단: 종합 ${overall}점 (${grade}등급)`;
  db.prepare(`
    INSERT INTO diagnoses (id, company_id, stage, scores_json, findings_json,
      recommendations_json, roi_projection_json, overall_score, overall_grade, summary)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(diagId, companyId, stage,
    JSON.stringify(scores), JSON.stringify(allFindings),
    JSON.stringify(recommendations), JSON.stringify(roiProjection),
    overall, grade, summary);

  // 회사 점수 업데이트
  ontology.updateCompany(db, companyId, {
    scores: { overall, grade, ...Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v.score])) },
  });

  // 벤치마크 업데이트
  if (company.industry) {
    for (const [area, result] of Object.entries(scores)) {
      ontology.updateBenchmark(db, company.industry, company.company_type, area, result.score);
    }
  }

  return {
    id: diagId,
    company: { id: company.id, name: company.name, type: company.company_type },
    stage,
    scores,
    overall,
    grade,
    findings: allFindings,
    recommendations,
    roiProjection,
    summary,
    meta: {
      departments: departments.length,
      employees: employees.length,
      processes: processes.length,
      systems: systems.length,
      activitiesAnalyzed: activities.length,
    },
  };
}

// ── 추천 생성 ────────────────────────────────────────────────────────────────

function generateRecommendations(scores, data) {
  const recs = [];

  if (scores.digitalization.score < 40) {
    recs.push({
      priority: 'high',
      area: 'digitalization',
      title: 'IT 시스템 도입',
      description: '기본 ERP/CRM 시스템 도입으로 업무 디지털화를 시작하세요.',
      estimatedImpact: '업무 시간 20-30% 절감',
      difficulty: 'medium',
    });
  }

  if (scores.processEfficiency.score < 50) {
    const worst = (data.processes || [])
      .filter(p => p.bottleneck_score > 0.5)
      .sort((a, b) => b.bottleneck_score - a.bottleneck_score)
      .slice(0, 3);
    if (worst.length > 0) {
      recs.push({
        priority: 'high',
        area: 'processEfficiency',
        title: '핵심 병목 프로세스 개선',
        description: `${worst.map(w => w.name).join(', ')} 프로세스의 병목을 해소하세요.`,
        estimatedImpact: `월 ${worst.reduce((s, w) => s + (w.estimated_savings_hrs || 0), 0).toFixed(0)}시간 절감`,
        difficulty: 'medium',
      });
    }
  }

  if (scores.humanCapability.score < 40) {
    recs.push({
      priority: 'medium',
      area: 'humanCapability',
      title: 'AI 도구 교육 프로그램',
      description: 'ChatGPT, Copilot 등 AI 도구 활용 교육으로 생산성을 높이세요.',
      estimatedImpact: '인당 주 2-5시간 절감',
      difficulty: 'low',
    });
  }

  if (scores.dataUtilization.score < 40) {
    recs.push({
      priority: 'medium',
      area: 'dataUtilization',
      title: '데이터 통합 및 대시보드 구축',
      description: '분산된 데이터를 통합하고 실시간 대시보드를 구축하세요.',
      estimatedImpact: '의사결정 속도 50% 향상',
      difficulty: 'high',
    });
  }

  const costMeta = scores.costStructure.meta || {};
  if (costMeta.totalSavingsKrw > 3000000) {
    recs.push({
      priority: 'high',
      area: 'costStructure',
      title: '반복 업무 자동화',
      description: `월 ${(costMeta.totalSavingsKrw / 10000).toFixed(0)}만원의 인건비를 자동화로 절감할 수 있습니다.`,
      estimatedImpact: `연 ${(costMeta.totalSavingsKrw * 12 / 10000).toFixed(0)}만원 절감`,
      difficulty: 'medium',
    });
  }

  if (scores.growthPotential.score > 60) {
    recs.push({
      priority: 'low',
      area: 'growthPotential',
      title: '확장 전략 수립',
      description: '높은 성장 잠재력을 활용한 시스템 확장 전략을 수립하세요.',
      estimatedImpact: '매출 성장 기반 마련',
      difficulty: 'high',
    });
  }

  return recs.sort((a, b) => {
    const p = { high: 3, medium: 2, low: 1 };
    return (p[b.priority] || 0) - (p[a.priority] || 0);
  });
}

// ── 시뮬레이션 (프로세스 자동화 what-if) ────────────────────────────────────

function simulateAutomation(db, companyId, processId, automationLevel = 0.8) {
  const ontology = require('./company-ontology');
  const processes = ontology.listProcesses(db, companyId);
  const target = processes.find(p => p.id === processId);
  if (!target) return null;

  const freqMap = { daily: 22, weekly: 4, monthly: 1, quarterly: 0.33, yearly: 0.083 };
  const freq = freqMap[target.frequency] || 1;
  const monthlyHrs = (target.avg_duration_min / 60) * freq * (target.involved_people || 1);
  const savedHrs = monthlyHrs * automationLevel;
  const savedKrw = Math.round(savedHrs * 25000);

  // 구현 비용 추정
  const difficultyMultiplier = { low: 500000, medium: 2000000, high: 5000000 };
  const implCost = difficultyMultiplier[target.automation_difficulty] || 2000000;
  const breakEvenMonths = savedKrw > 0 ? Math.ceil(implCost / savedKrw) : 999;

  return {
    process: { id: target.id, name: target.name },
    automationLevel: Math.round(automationLevel * 100),
    currentMonthlyHours: Math.round(monthlyHrs * 10) / 10,
    savedMonthlyHours: Math.round(savedHrs * 10) / 10,
    savedMonthlyKrw: savedKrw,
    savedYearlyKrw: savedKrw * 12,
    implementationCost: implCost,
    breakEvenMonths,
    threeYearNet: savedKrw * 36 - implCost,
    roi3Year: implCost > 0 ? Math.round(((savedKrw * 36 - implCost) / implCost) * 100) : 0,
  };
}

// ── 진단 히스토리 ────────────────────────────────────────────────────────────

function getDiagnosisHistory(db, companyId) {
  return db.prepare(`
    SELECT * FROM diagnoses WHERE company_id = ? ORDER BY diagnosed_at DESC
  `).all(companyId).map(r => ({
    ...r,
    scores: tryParse(r.scores_json),
    findings: tryParse(r.findings_json),
    recommendations: tryParse(r.recommendations_json),
    roi_projection: tryParse(r.roi_projection_json),
  }));
}

function tryParse(s) {
  if (!s || typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

module.exports = {
  runDiagnosis,
  simulateAutomation,
  getDiagnosisHistory,
  // 개별 점수 함수 (테스트용)
  scoreDigitalization,
  scoreProcessEfficiency,
  scoreDataUtilization,
  scoreHumanCapability,
  scoreCostStructure,
  scoreGrowthPotential,
};
