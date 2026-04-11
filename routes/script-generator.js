'use strict';
/**
 * script-generator.js — Phase 4: Vision 분석 → 자동화 스크립트 자동 생성
 *
 * Vision 데이터(screen.analyzed)에서 automatable 패턴을 추출하고
 * nenovaInputMap/autoAreas/scriptType 기반으로 실행 가능한 스크립트를 자동 생성한다.
 *
 * 엔드포인트:
 *   GET  /api/scripts/scan           — automatable 패턴 스캔 + 그룹핑
 *   POST /api/scripts/generate       — 단일 스크립트 생성 (action+inputMap 기반)
 *   POST /api/scripts/batch          — 배치 스크립트 생성 (고점수 항목 일괄)
 *   GET  /api/scripts/list           — 생성된 스크립트 목록
 *   GET  /api/scripts/:id            — 스크립트 상세
 *   PUT  /api/scripts/:id            — 스크립트 수정
 *   DELETE /api/scripts/:id          — 스크립트 삭제
 *   POST /api/scripts/:id/deploy     — 스크립트 배포 (PC 큐잉)
 *   GET  /api/scripts/stats          — 자동화 통계 요약
 */
const express = require('express');

function createScriptGenerator({ getDb }) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════════
  // 테이블 초기화
  // ═══════════════════════════════════════════════════════════════
  let _tablesReady = false;
  async function _ensureTables(db) {
    if (_tablesReady) return;
    await db.query(`
      CREATE TABLE IF NOT EXISTS generated_scripts (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        action_type TEXT NOT NULL,
        script_type TEXT NOT NULL DEFAULT 'pyautogui',
        script_content TEXT NOT NULL,
        target_app TEXT DEFAULT 'nenova',
        target_screen TEXT,
        input_map JSONB DEFAULT '[]',
        auto_areas JSONB DEFAULT '[]',
        source_event_ids TEXT[] DEFAULT '{}',
        status TEXT DEFAULT 'draft',
        test_result JSONB,
        deploy_count INT DEFAULT 0,
        success_count INT DEFAULT 0,
        fail_count INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_gs_action ON generated_scripts(action_type)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_gs_status ON generated_scripts(status)`);
    _tablesReady = true;
  }

  // ═══════════════════════════════════════════════════════════════
  // nenova 액션별 스크립트 템플릿 (Vision 데이터에서 학습한 패턴)
  // ═══════════════════════════════════════════════════════════════
  const ACTION_TEMPLATES = {
    '주문 입력': {
      description: 'nenova 주문 관리 화면에서 신규 주문 등록',
      requiredFields: ['고객명', '품목', '수량'],
      optionalFields: ['날짜', '단가', '비고'],
      windowTitle: '*화훼*관리*',
      steps: [
        { type: 'focus', target: 'nenova', wait: 0.5 },
        { type: 'click', element: '신규주문', wait: 1.0 },
        { type: 'input', field: '고객명', source: 'variable' },
        { type: 'tab' },
        { type: 'input', field: '품목', source: 'variable' },
        { type: 'tab' },
        { type: 'input', field: '수량', source: 'variable' },
        { type: 'click', element: '저장', wait: 1.0 },
        { type: 'screenshot', purpose: 'verification' },
      ],
    },
    '주문 수정': {
      description: 'nenova 기존 주문 수정',
      requiredFields: ['주문번호'],
      optionalFields: ['수량', '품목', '고객명'],
      windowTitle: '*화훼*관리*',
      steps: [
        { type: 'focus', target: 'nenova', wait: 0.5 },
        { type: 'click', element: '조회', wait: 0.5 },
        { type: 'input', field: '주문번호', source: 'variable' },
        { type: 'key', key: 'enter', wait: 1.0 },
        { type: 'doubleclick', element: '주문행', wait: 0.5 },
        { type: 'input_dynamic', fields: 'optionalFields' },
        { type: 'click', element: '저장', wait: 1.0 },
        { type: 'screenshot', purpose: 'verification' },
      ],
    },
    '출고 처리': {
      description: 'nenova 출고 관리 — 출고 등록 및 전표 처리',
      requiredFields: ['거래처', '품목', '수량'],
      optionalFields: ['출고일', '차량'],
      windowTitle: '*출고*',
      steps: [
        { type: 'focus', target: 'nenova', wait: 0.5 },
        { type: 'navigate', menu: '출고관리', wait: 1.0 },
        { type: 'click', element: '신규', wait: 0.5 },
        { type: 'input', field: '거래처', source: 'variable' },
        { type: 'tab' },
        { type: 'input', field: '품목', source: 'variable' },
        { type: 'tab' },
        { type: 'input', field: '수량', source: 'variable' },
        { type: 'click', element: '저장', wait: 1.0 },
        { type: 'screenshot', purpose: 'verification' },
      ],
    },
    '재고 조회': {
      description: 'nenova 재고 현황 조회',
      requiredFields: [],
      optionalFields: ['품목', '날짜'],
      windowTitle: '*재고*',
      steps: [
        { type: 'focus', target: 'nenova', wait: 0.5 },
        { type: 'navigate', menu: '재고관리', wait: 1.0 },
        { type: 'input_optional', field: '품목', source: 'variable' },
        { type: 'click', element: '조회', wait: 1.5 },
        { type: 'screenshot', purpose: 'data_capture' },
      ],
    },
    '거래처 관리': {
      description: '거래처 정보 조회/수정',
      requiredFields: ['거래처명'],
      optionalFields: ['연락처', '주소', '담당자'],
      windowTitle: '*거래처*',
      steps: [
        { type: 'focus', target: 'nenova', wait: 0.5 },
        { type: 'navigate', menu: '거래처관리', wait: 1.0 },
        { type: 'input', field: '거래처명', source: 'variable' },
        { type: 'click', element: '조회', wait: 1.0 },
        { type: 'screenshot', purpose: 'data_capture' },
      ],
    },
    '엑셀 데이터 입력': {
      description: 'Excel 반복 데이터 입력 자동화',
      requiredFields: ['데이터'],
      optionalFields: ['시트명', '시작셀'],
      windowTitle: '*Excel*',
      steps: [
        { type: 'focus', target: 'excel', wait: 0.5 },
        { type: 'input_bulk', field: '데이터', source: 'variable' },
        { type: 'key', key: 'ctrl+s', wait: 0.5 },
        { type: 'screenshot', purpose: 'verification' },
      ],
    },
    '카카오톡 메시지': {
      description: '카카오톡 채팅방에 메시지 전송',
      requiredFields: ['채팅방', '메시지'],
      optionalFields: [],
      windowTitle: '*카카오톡*',
      steps: [
        { type: 'focus', target: 'kakaotalk', wait: 0.5 },
        { type: 'search_room', field: '채팅방', source: 'variable' },
        { type: 'input', field: '메시지', source: 'variable' },
        { type: 'key', key: 'enter' },
      ],
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // nenovaAction → ACTION_TEMPLATES 매핑
  // ═══════════════════════════════════════════════════════════════
  function _matchAction(nenovaAction, screen, app) {
    if (!nenovaAction && !screen && !app) return null;
    const text = `${nenovaAction || ''} ${screen || ''} ${app || ''}`.toLowerCase();
    if (/주문.*입력|신규.*주문|order.*entry/.test(text)) return '주문 입력';
    if (/주문.*수정|order.*modify/.test(text)) return '주문 수정';
    if (/출고|shipment|배송/.test(text)) return '출고 처리';
    if (/재고|inventory|stock/.test(text)) return '재고 조회';
    if (/거래처|customer|고객/.test(text)) return '거래처 관리';
    if (/excel|엑셀|스프레드/.test(text)) return '엑셀 데이터 입력';
    if (/카카오|kakao|채팅|메시지/.test(text)) return '카카오톡 메시지';
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // 스크립트 생성기 — pyautogui
  // ═══════════════════════════════════════════════════════════════
  function _generatePyautogui(actionType, template, inputMap, coordMap, variables) {
    const lines = [
      '# -*- coding: utf-8 -*-',
      `"""`,
      `Orbit AI 자동화 스크립트`,
      `액션: ${actionType}`,
      `설명: ${template.description}`,
      `생성: ${new Date().toISOString()}`,
      `"""`,
      'import pyautogui',
      'import time',
      'import subprocess',
      '',
      '# 안전 설정',
      'pyautogui.FAILSAFE = True',
      'pyautogui.PAUSE = 0.3',
      '',
    ];

    // 변수 선언
    const allFields = [...template.requiredFields, ...template.optionalFields];
    const fieldValues = {};
    for (const f of allFields) {
      const mapped = (inputMap || []).find(m => m.field === f || m.label === f);
      const val = variables?.[f] || mapped?.value || '';
      fieldValues[f] = val;
      const varName = f.replace(/\s/g, '_');
      if (val) {
        lines.push(`${varName} = "${val}"  # ${mapped?.source || 'manual'}`);
      } else {
        lines.push(`${varName} = input("${f} 입력: ")  # 수동 입력 필요`);
      }
    }
    lines.push('');

    // 헬퍼 함수
    lines.push('# ── 헬퍼 함수 ──');
    lines.push('def clipboard_type(text):');
    lines.push('    """한글 입력용 클립보드 방식"""');
    lines.push("    subprocess.run(['powershell', '-Command', f\"Set-Clipboard -Value '{text}'\"], capture_output=True)");
    lines.push("    pyautogui.hotkey('ctrl', 'v')");
    lines.push('    time.sleep(0.2)');
    lines.push('');
    lines.push('def safe_click(x, y, label=""):');
    lines.push('    """안전 클릭 — 좌표 확인 후 클릭"""');
    lines.push('    if x and y:');
    lines.push('        pyautogui.click(x=x, y=y)');
    lines.push('    else:');
    lines.push('        print(f"WARNING: {label} 좌표 미확인")');
    lines.push('');

    // 메인 로직
    lines.push('# ══════════════════════════════════════');
    lines.push(`# ${actionType}`);
    lines.push('# ══════════════════════════════════════');
    lines.push('');

    for (const step of template.steps) {
      switch (step.type) {
        case 'focus': {
          const app = step.target === 'nenova' ? '화훼' : step.target;
          lines.push(`# 창 포커스: ${step.target}`);
          lines.push('try:');
          lines.push('    import pygetwindow as gw');
          lines.push(`    wins = [w for w in gw.getAllWindows() if '${app}' in w.title]`);
          lines.push('    if wins: wins[0].activate()');
          lines.push('except: pass');
          if (step.wait) lines.push(`time.sleep(${step.wait})`);
          lines.push('');
          break;
        }
        case 'click': {
          const coord = coordMap?.[step.element];
          if (coord) {
            lines.push(`# ${step.element} 클릭 (학습좌표)`);
            lines.push(`safe_click(${coord.x}, ${coord.y}, "${step.element}")`);
          } else {
            lines.push(`# ${step.element} 클릭 — 이미지 탐색`);
            lines.push('try:');
            lines.push(`    loc = pyautogui.locateOnScreen('${step.element}.png', confidence=0.8)`);
            lines.push(`    if loc: pyautogui.click(pyautogui.center(loc))`);
            lines.push(`    else: print("WARNING: ${step.element} not found")`);
            lines.push(`except: print("WARNING: ${step.element} locate failed")`);
          }
          if (step.wait) lines.push(`time.sleep(${step.wait})`);
          lines.push('');
          break;
        }
        case 'doubleclick': {
          const coord = coordMap?.[step.element];
          if (coord) {
            lines.push(`# ${step.element} 더블클릭`);
            lines.push(`pyautogui.doubleClick(x=${coord.x}, y=${coord.y})`);
          } else {
            lines.push(`# ${step.element} 더블클릭 — 좌표 미확인`);
            lines.push(`# pyautogui.doubleClick(x=???, y=???)`);
          }
          if (step.wait) lines.push(`time.sleep(${step.wait})`);
          lines.push('');
          break;
        }
        case 'input': {
          const varName = step.field.replace(/\s/g, '_');
          const coord = coordMap?.[step.field];
          if (coord) {
            lines.push(`# ${step.field} 입력 (학습좌표)`);
            lines.push(`safe_click(${coord.x}, ${coord.y}, "${step.field}")`);
            lines.push('time.sleep(0.2)');
          } else {
            lines.push(`# ${step.field} 입력 — 좌표 미확인, Tab으로 이동`);
          }
          lines.push(`pyautogui.hotkey('ctrl', 'a')`);
          lines.push(`clipboard_type(${varName})`);
          lines.push('');
          break;
        }
        case 'input_optional': {
          const varName = step.field.replace(/\s/g, '_');
          lines.push(`# ${step.field} (선택 입력)`);
          lines.push(`if ${varName}:`);
          lines.push(`    clipboard_type(${varName})`);
          lines.push('');
          break;
        }
        case 'input_dynamic': {
          lines.push('# 동적 필드 입력');
          for (const f of template.optionalFields) {
            const varName = f.replace(/\s/g, '_');
            lines.push(`if ${varName}:`);
            lines.push(`    clipboard_type(${varName})`);
            lines.push('    pyautogui.press("tab")');
          }
          lines.push('');
          break;
        }
        case 'input_bulk': {
          lines.push('# 대량 데이터 입력');
          lines.push('if isinstance(데이터, list):');
          lines.push('    for row in 데이터:');
          lines.push('        for cell in row:');
          lines.push('            clipboard_type(str(cell))');
          lines.push("            pyautogui.press('tab')");
          lines.push("        pyautogui.press('enter')");
          lines.push('');
          break;
        }
        case 'tab':
          lines.push("pyautogui.press('tab')");
          lines.push('time.sleep(0.1)');
          lines.push('');
          break;
        case 'key':
          if (step.key.includes('+')) {
            const keys = step.key.split('+');
            lines.push(`pyautogui.hotkey('${keys.join("', '")}')`);
          } else {
            lines.push(`pyautogui.press('${step.key}')`);
          }
          if (step.wait) lines.push(`time.sleep(${step.wait})`);
          lines.push('');
          break;
        case 'navigate':
          lines.push(`# 메뉴 이동: ${step.menu}`);
          lines.push(`# pyautogui 메뉴 탐색 — 트리뷰 클릭`);
          lines.push('try:');
          lines.push(`    loc = pyautogui.locateOnScreen('menu_${step.menu}.png', confidence=0.7)`);
          lines.push('    if loc: pyautogui.click(pyautogui.center(loc))');
          lines.push(`    else: print("메뉴 '${step.menu}' 이미지 없음 — 수동 이동 필요")`);
          lines.push('except: pass');
          if (step.wait) lines.push(`time.sleep(${step.wait})`);
          lines.push('');
          break;
        case 'search_room':
          lines.push('# 카카오톡 채팅방 검색');
          lines.push("pyautogui.hotkey('ctrl', 'f')");
          lines.push('time.sleep(0.3)');
          lines.push(`clipboard_type(${step.field.replace(/\s/g, '_')})`);
          lines.push("pyautogui.press('enter')");
          lines.push('time.sleep(0.5)');
          lines.push('');
          break;
        case 'screenshot':
          lines.push(`# 스크린샷: ${step.purpose}`);
          lines.push('screenshot = pyautogui.screenshot()');
          lines.push(`screenshot.save(f'orbit_${actionType.replace(/\s/g, '_')}_{int(time.time())}.png')`);
          lines.push('');
          break;
      }
    }

    lines.push("print('═══ 자동화 완료 ═══')");
    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════
  // 스크립트 생성기 — Power Automate Desktop (PAD)
  // ═══════════════════════════════════════════════════════════════
  function _generatePAD(actionType, template, inputMap, variables) {
    const lines = [
      `# PAD Flow: ${actionType}`,
      `# ${template.description}`,
      `# Generated: ${new Date().toISOString()}`,
      '',
      '# 변수 설정',
    ];

    for (const f of template.requiredFields) {
      const mapped = (inputMap || []).find(m => m.field === f || m.label === f);
      const val = variables?.[f] || mapped?.value || '';
      lines.push(`SET ${f.replace(/\s/g, '_')} TO '${val}'`);
    }
    lines.push('');

    for (const step of template.steps) {
      switch (step.type) {
        case 'focus':
          lines.push(`UI.FocusWindow Title: '${template.windowTitle}'`);
          if (step.wait) lines.push(`WAIT ${step.wait}`);
          break;
        case 'click':
          lines.push(`UI.Click Element: '${step.element}'`);
          if (step.wait) lines.push(`WAIT ${step.wait}`);
          break;
        case 'input':
          lines.push(`UI.SetText Element: '${step.field}' Value: %${step.field.replace(/\s/g, '_')}%`);
          break;
        case 'tab':
          lines.push("Keyboard.Press Key: 'Tab'");
          break;
        case 'key':
          lines.push(`Keyboard.Press Key: '${step.key}'`);
          if (step.wait) lines.push(`WAIT ${step.wait}`);
          break;
        case 'screenshot':
          lines.push(`Screen.TakeScreenshot SaveTo: 'orbit_capture.png'`);
          break;
        case 'navigate':
          lines.push(`UI.Click Element: '${step.menu}'`);
          if (step.wait) lines.push(`WAIT ${step.wait}`);
          break;
      }
    }
    lines.push('');
    lines.push('# 완료');
    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════
  // 스크립트 생성기 — AutoHotkey (AHK)
  // ═══════════════════════════════════════════════════════════════
  function _generateAHK(actionType, template, inputMap, coordMap, variables) {
    const lines = [
      `; Orbit AI 자동화 — ${actionType}`,
      `; ${template.description}`,
      `; Generated: ${new Date().toISOString()}`,
      '#Requires AutoHotkey v2.0',
      '#SingleInstance Force',
      '',
    ];

    for (const f of template.requiredFields) {
      const mapped = (inputMap || []).find(m => m.field === f || m.label === f);
      const val = variables?.[f] || mapped?.value || '';
      lines.push(`${f.replace(/\s/g, '_')} := "${val}"`);
    }
    lines.push('');

    for (const step of template.steps) {
      switch (step.type) {
        case 'focus': {
          const win = step.target === 'nenova' ? '화훼' : step.target;
          lines.push(`WinActivate "${win}"`);
          lines.push(`WinWaitActive "${win}",, 5`);
          if (step.wait) lines.push(`Sleep ${step.wait * 1000}`);
          break;
        }
        case 'click': {
          const coord = coordMap?.[step.element];
          if (coord) {
            lines.push(`Click ${coord.x}, ${coord.y}  ; ${step.element}`);
          } else {
            lines.push(`; ${step.element} — 좌표 미확인`);
          }
          if (step.wait) lines.push(`Sleep ${step.wait * 1000}`);
          break;
        }
        case 'input': {
          const varName = step.field.replace(/\s/g, '_');
          lines.push(`A_Clipboard := ${varName}`);
          lines.push('Sleep 100');
          lines.push('Send "^v"');
          lines.push('Sleep 200');
          break;
        }
        case 'tab':
          lines.push('Send "{Tab}"');
          break;
        case 'key':
          if (step.key === 'enter') lines.push('Send "{Enter}"');
          else if (step.key.includes('+')) {
            const k = step.key.replace('ctrl', '^').replace('shift', '+').replace('alt', '!');
            lines.push(`Send "${k}"`);
          } else lines.push(`Send "{${step.key}}"`);
          if (step.wait) lines.push(`Sleep ${step.wait * 1000}`);
          break;
        case 'screenshot':
          lines.push('; 스크린샷 — 외부 도구 사용');
          break;
      }
    }
    lines.push('');
    lines.push('MsgBox "자동화 완료"');
    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════
  // 스크립트 생성기 — PowerShell COM
  // ═══════════════════════════════════════════════════════════════
  function _generatePowerShell(actionType, template, inputMap, variables) {
    const lines = [
      `# Orbit AI 자동화 — ${actionType}`,
      `# ${template.description}`,
      `# Generated: ${new Date().toISOString()}`,
      '',
      'Add-Type -AssemblyName System.Windows.Forms',
      '',
    ];

    for (const f of template.requiredFields) {
      const mapped = (inputMap || []).find(m => m.field === f || m.label === f);
      const val = variables?.[f] || mapped?.value || '';
      lines.push(`$${f.replace(/\s/g, '_')} = "${val}"`);
    }
    lines.push('');

    lines.push('function Send-ClipboardText($text) {');
    lines.push('    [System.Windows.Forms.Clipboard]::SetText($text)');
    lines.push('    Start-Sleep -Milliseconds 100');
    lines.push('    [System.Windows.Forms.SendKeys]::SendWait("^v")');
    lines.push('    Start-Sleep -Milliseconds 200');
    lines.push('}');
    lines.push('');

    for (const step of template.steps) {
      switch (step.type) {
        case 'focus':
          lines.push(`# 창 활성화: ${step.target}`);
          lines.push(`$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '${template.windowTitle}' } | Select-Object -First 1`);
          lines.push('if ($proc) {');
          lines.push('    [void][System.Runtime.InteropServices.Marshal]');
          lines.push('    $hwnd = $proc.MainWindowHandle');
          lines.push('    Add-Type @"');
          lines.push('    using System; using System.Runtime.InteropServices;');
          lines.push('    public class Win32 { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); }');
          lines.push('"@');
          lines.push('    [Win32]::SetForegroundWindow($hwnd)');
          lines.push('}');
          if (step.wait) lines.push(`Start-Sleep -Milliseconds ${step.wait * 1000}`);
          break;
        case 'click':
          lines.push(`# ${step.element} 클릭`);
          lines.push(`[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(0, 0)  # 좌표 필요`);
          lines.push('[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")  # 대안: Enter');
          if (step.wait) lines.push(`Start-Sleep -Milliseconds ${step.wait * 1000}`);
          break;
        case 'input': {
          const varName = step.field.replace(/\s/g, '_');
          lines.push(`Send-ClipboardText $${varName}`);
          break;
        }
        case 'tab':
          lines.push('[System.Windows.Forms.SendKeys]::SendWait("{TAB}")');
          break;
        case 'key':
          if (step.key === 'enter') lines.push('[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")');
          else lines.push(`[System.Windows.Forms.SendKeys]::SendWait("${step.key}")`);
          if (step.wait) lines.push(`Start-Sleep -Milliseconds ${step.wait * 1000}`);
          break;
      }
    }
    lines.push('');
    lines.push('Write-Host "자동화 완료"');
    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════
  // GET /api/scripts/scan — automatable 패턴 스캔 + 그룹핑
  // ═══════════════════════════════════════════════════════════════
  router.get('/scan', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const limit = parseInt(req.query.limit) || 500;
      const minScore = parseFloat(req.query.minScore) || 0.3;

      // Vision 분석 데이터 조회
      const { rows } = await db.query(`
        SELECT id, user_id, timestamp, data_json
        FROM events
        WHERE type = 'screen.analyzed'
        ORDER BY timestamp DESC
        LIMIT $1
      `, [limit]);

      const patterns = {};
      const allItems = [];

      for (const r of rows) {
        let d = {};
        try { d = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : r.data_json; } catch {}

        const score = parseFloat(d.automationScore) || 0;
        if (score < minScore) continue;

        const item = {
          eventId: r.id,
          userId: r.user_id,
          timestamp: r.timestamp,
          app: d.app || '',
          screen: d.screen || '',
          activity: d.activity || '',
          nenovaAction: d.nenovaAction || null,
          automationScore: score,
          automationHint: d.automationHint || '',
          scriptType: d.scriptType || 'none',
          padPossible: d.padPossible || false,
          nenovaInputMap: d.nenovaInputMap || [],
          autoAreas: d.autoAreas || [],
          humanAreas: d.humanAreas || [],
          fields: d.fields || [],
        };

        allItems.push(item);

        // 액션별 그룹핑
        const actionType = _matchAction(item.nenovaAction, item.screen, item.app) || item.nenovaAction || item.screen || 'unknown';
        if (!patterns[actionType]) {
          patterns[actionType] = {
            actionType,
            count: 0,
            avgScore: 0,
            maxScore: 0,
            totalScore: 0,
            hasTemplate: !!ACTION_TEMPLATES[actionType],
            inputMaps: [],
            eventIds: [],
            scriptTypes: {},
            screens: new Set(),
          };
        }
        const p = patterns[actionType];
        p.count++;
        p.totalScore += score;
        p.maxScore = Math.max(p.maxScore, score);
        p.eventIds.push(r.id);
        if (item.nenovaInputMap.length > 0) p.inputMaps.push(item.nenovaInputMap);
        if (item.scriptType) p.scriptTypes[item.scriptType] = (p.scriptTypes[item.scriptType] || 0) + 1;
        p.screens.add(item.screen);
      }

      // 평균 계산 + Set → Array
      const grouped = Object.values(patterns).map(p => ({
        ...p,
        avgScore: +(p.totalScore / p.count).toFixed(3),
        screens: [...p.screens].filter(Boolean),
        inputMaps: p.inputMaps.slice(0, 3), // 대표 샘플 3개
        eventIds: p.eventIds.slice(0, 10),
        generatable: p.hasTemplate || p.count >= 3,
      })).sort((a, b) => b.avgScore - a.avgScore);

      res.json({
        totalScanned: rows.length,
        automatableCount: allItems.length,
        patternCount: grouped.length,
        patterns: grouped,
        scoreDistribution: {
          high: allItems.filter(i => i.automationScore >= 0.8).length,
          mid: allItems.filter(i => i.automationScore >= 0.5 && i.automationScore < 0.8).length,
          low: allItems.filter(i => i.automationScore >= 0.3 && i.automationScore < 0.5).length,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/scripts/generate — 단일 스크립트 생성
  // ═══════════════════════════════════════════════════════════════
  router.post('/generate', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const {
        actionType,
        scriptType = 'pyautogui',
        inputMap = [],
        variables = {},
        name,
        eventIds = [],
      } = req.body;

      if (!actionType) return res.status(400).json({ error: 'actionType 필요' });

      const template = ACTION_TEMPLATES[actionType];
      if (!template) {
        return res.status(404).json({
          error: `템플릿 없음: ${actionType}`,
          available: Object.keys(ACTION_TEMPLATES),
        });
      }

      // 학습된 좌표 로드
      let coordMap = {};
      try {
        const { rows } = await db.query('SELECT element_name, x, y, confidence FROM pad_mouse_map WHERE confidence >= 0.3');
        for (const c of rows) coordMap[c.element_name] = c;
      } catch {}

      // 스크립트 생성
      let script;
      switch (scriptType) {
        case 'pad':
          script = _generatePAD(actionType, template, inputMap, variables);
          break;
        case 'ahk':
          script = _generateAHK(actionType, template, inputMap, coordMap, variables);
          break;
        case 'powershell':
          script = _generatePowerShell(actionType, template, inputMap, variables);
          break;
        case 'pyautogui':
        default:
          script = _generatePyautogui(actionType, template, inputMap, coordMap, variables);
          break;
      }

      // DB 저장
      const scriptName = name || `${actionType}_${scriptType}_${Date.now()}`;
      const { rows: inserted } = await db.query(`
        INSERT INTO generated_scripts
          (name, action_type, script_type, script_content, target_app, target_screen,
           input_map, source_event_ids, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'draft')
        RETURNING id, name, action_type, script_type, status, created_at
      `, [
        scriptName, actionType, scriptType, script,
        template.windowTitle?.includes('nenova') || template.windowTitle?.includes('화훼') ? 'nenova' : 'other',
        template.windowTitle,
        JSON.stringify(inputMap),
        eventIds,
      ]);

      res.json({
        ok: true,
        script: {
          ...inserted[0],
          content: script,
          template: { description: template.description, requiredFields: template.requiredFields },
          coordsUsed: Object.keys(coordMap).length,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/scripts/batch — 배치 스크립트 생성
  // ═══════════════════════════════════════════════════════════════
  router.post('/batch', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const { minScore = 0.5, scriptType = 'pyautogui', limit = 20 } = req.body;

      // Vision 데이터에서 고점수 항목 스캔
      const { rows } = await db.query(`
        SELECT id, data_json FROM events
        WHERE type = 'screen.analyzed'
        ORDER BY timestamp DESC LIMIT 500
      `);

      let coordMap = {};
      try {
        const cr = await db.query('SELECT element_name, x, y, confidence FROM pad_mouse_map WHERE confidence >= 0.3');
        for (const c of cr.rows) coordMap[c.element_name] = c;
      } catch {}

      const generated = [];
      const skipped = [];
      const seen = new Set();

      for (const r of rows) {
        if (generated.length >= limit) break;

        let d = {};
        try { d = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : r.data_json; } catch {}

        const score = parseFloat(d.automationScore) || 0;
        if (score < minScore) continue;

        const actionType = _matchAction(d.nenovaAction, d.screen, d.app);
        if (!actionType || seen.has(actionType)) {
          if (!actionType) skipped.push({ id: r.id, reason: 'no_matching_template', action: d.nenovaAction, screen: d.screen });
          continue;
        }
        seen.add(actionType);

        const template = ACTION_TEMPLATES[actionType];
        if (!template) continue;

        let script;
        switch (scriptType) {
          case 'pad': script = _generatePAD(actionType, template, d.nenovaInputMap, {}); break;
          case 'ahk': script = _generateAHK(actionType, template, d.nenovaInputMap, coordMap, {}); break;
          case 'powershell': script = _generatePowerShell(actionType, template, d.nenovaInputMap, {}); break;
          default: script = _generatePyautogui(actionType, template, d.nenovaInputMap, coordMap, {}); break;
        }

        const scriptName = `batch_${actionType}_${scriptType}`;
        try {
          const { rows: ins } = await db.query(`
            INSERT INTO generated_scripts
              (name, action_type, script_type, script_content, target_app, target_screen,
               input_map, source_event_ids, status)
            VALUES ($1, $2, $3, $4, 'nenova', $5, $6::jsonb, $7, 'draft')
            ON CONFLICT DO NOTHING
            RETURNING id, name, action_type, script_type, status
          `, [scriptName, actionType, scriptType, script, template.windowTitle, JSON.stringify(d.nenovaInputMap || []), [r.id]]);
          if (ins.length > 0) generated.push(ins[0]);
        } catch {}
      }

      res.json({
        ok: true,
        generated: generated.length,
        skipped: skipped.length,
        scripts: generated,
        skippedDetails: skipped.slice(0, 10),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/scripts/list — 생성된 스크립트 목록
  // ═══════════════════════════════════════════════════════════════
  router.get('/list', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const status = req.query.status;
      const actionType = req.query.actionType;

      let q = `SELECT id, name, action_type, script_type, target_app, target_screen,
               status, deploy_count, success_count, fail_count, created_at, updated_at
               FROM generated_scripts WHERE 1=1`;
      const params = [];
      if (status) { params.push(status); q += ` AND status = $${params.length}`; }
      if (actionType) { params.push(actionType); q += ` AND action_type = $${params.length}`; }
      q += ' ORDER BY created_at DESC LIMIT 100';

      const { rows } = await db.query(q, params);

      const stats = { total: rows.length, draft: 0, tested: 0, deployed: 0, failed: 0 };
      rows.forEach(r => { if (stats[r.status] !== undefined) stats[r.status]++; });

      res.json({ scripts: rows, stats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/scripts/stats — 자동화 통계 요약 (/:id 보다 먼저 선언)
  // ═══════════════════════════════════════════════════════════════
  router.get('/stats', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const scriptStats = await db.query(`
        SELECT
          COUNT(*) as total_scripts,
          COUNT(*) FILTER (WHERE status = 'draft') as draft,
          COUNT(*) FILTER (WHERE status = 'tested') as tested,
          COUNT(*) FILTER (WHERE status = 'deployed') as deployed,
          SUM(deploy_count) as total_deploys,
          SUM(success_count) as total_success,
          SUM(fail_count) as total_fails
        FROM generated_scripts
      `);

      const visionStats = await db.query(`
        SELECT
          COUNT(*) as total_analyzed,
          COUNT(*) FILTER (WHERE (data_json->>'automationScore')::float >= 0.8) as score_high,
          COUNT(*) FILTER (WHERE (data_json->>'automationScore')::float >= 0.5 AND (data_json->>'automationScore')::float < 0.8) as score_mid,
          COUNT(*) FILTER (WHERE (data_json->>'automationScore')::float > 0 AND (data_json->>'automationScore')::float < 0.5) as score_low,
          COUNT(*) FILTER (WHERE data_json->>'nenovaAction' IS NOT NULL) as with_action,
          COUNT(*) FILTER (WHERE data_json->>'nenovaInputMap' IS NOT NULL AND data_json->>'nenovaInputMap' != '[]') as with_input_map
        FROM events WHERE type = 'screen.analyzed'
      `);

      const byAction = await db.query(`
        SELECT action_type, COUNT(*) as count, SUM(deploy_count) as deploys
        FROM generated_scripts
        GROUP BY action_type ORDER BY count DESC
      `);

      const templates = Object.entries(ACTION_TEMPLATES).map(([k, v]) => ({
        actionType: k,
        description: v.description,
        requiredFields: v.requiredFields,
        optionalFields: v.optionalFields,
      }));

      res.json({
        scripts: scriptStats.rows[0] || {},
        vision: visionStats.rows[0] || {},
        byAction: byAction.rows,
        availableTemplates: templates,
        supportedTypes: ['pyautogui', 'pad', 'ahk', 'powershell'],
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/scripts/:id — 스크립트 상세
  // ═══════════════════════════════════════════════════════════════
  router.get('/:id', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      await _ensureTables(db);

      const { rows } = await db.query('SELECT * FROM generated_scripts WHERE id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Script not found' });

      res.json({ script: rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // PUT /api/scripts/:id — 스크립트 수정
  // ═══════════════════════════════════════════════════════════════
  router.put('/:id', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const { name, script_content, status } = req.body;
      const updates = [];
      const params = [];

      if (name) { params.push(name); updates.push(`name = $${params.length}`); }
      if (script_content) { params.push(script_content); updates.push(`script_content = $${params.length}`); }
      if (status) { params.push(status); updates.push(`status = $${params.length}`); }
      updates.push('updated_at = NOW()');

      if (updates.length === 1) return res.status(400).json({ error: 'Nothing to update' });

      params.push(req.params.id);
      const { rows } = await db.query(
        `UPDATE generated_scripts SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Script not found' });

      res.json({ ok: true, script: rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // DELETE /api/scripts/:id — 스크립트 삭제
  // ═══════════════════════════════════════════════════════════════
  router.delete('/:id', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const { rowCount } = await db.query('DELETE FROM generated_scripts WHERE id = $1', [req.params.id]);
      res.json({ ok: true, deleted: rowCount > 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/scripts/:id/deploy — 스크립트 배포 (PC 큐잉)
  // ═══════════════════════════════════════════════════════════════
  router.post('/:id/deploy', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const { hostname } = req.body;
      if (!hostname) return res.status(400).json({ error: 'hostname 필요' });

      // 스크립트 조회
      const { rows } = await db.query('SELECT * FROM generated_scripts WHERE id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Script not found' });

      const script = rows[0];

      // 데몬 명령 큐잉
      await db.query(`
        INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts)
        VALUES ($1, 'run-script', NULL, $2::jsonb, NOW())
      `, [
        hostname,
        JSON.stringify({
          scriptId: script.id,
          scriptType: script.script_type,
          script: script.script_content,
          actionType: script.action_type,
          source: 'script-generator',
          ts: new Date().toISOString(),
        }),
      ]);

      // 배포 카운트 증가
      await db.query('UPDATE generated_scripts SET deploy_count = deploy_count + 1, status = $1, updated_at = NOW() WHERE id = $2',
        ['deployed', script.id]);

      res.json({
        ok: true,
        deployed: { scriptId: script.id, hostname, actionType: script.action_type },
        message: `${hostname}에 "${script.action_type}" 스크립트 배포 완료`,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createScriptGenerator;
