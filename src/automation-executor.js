'use strict';
/**
 * automation-executor.js — 학습된 워크플로우 → 실행 가능한 자동화 스크립트 생성
 *
 * 지원 출력 형식:
 * 1. Python (pyautogui) — 화면 인식 + 자동 클릭/입력
 * 2. PowerShell — Windows 앱 조작 + COM 자동화 (Excel/Word)
 * 3. AutoHotkey — 키보드/마우스 매크로
 * 4. Power Automate Desktop — Microsoft 공식 RPA
 * 5. CLI 명령 — 명령줄 작업
 *
 * 흐름: workflow-learner 템플릿 → 이 모듈에서 스크립트 생성 → 사용자 확인 → 실행
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRIPTS_DIR = path.join(os.homedir(), '.orbit', 'automations');

function ensureDir() {
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
}

// ═══════════════════════════════════════════════════════════════
// Python (pyautogui) 생성 — 화면 인식 + 클릭/입력
// ═══════════════════════════════════════════════════════════════

function generatePython(template) {
  const lines = [
    '#!/usr/bin/env python3',
    '"""',
    `Orbit AI 자동화 스크립트 — ${template.description}`,
    `생성: ${new Date().toISOString()}`,
    `반복 횟수: ${template.repeatCount}회 학습됨`,
    '"""',
    'import pyautogui',
    'import time',
    'import subprocess',
    '',
    'pyautogui.FAILSAFE = True  # 마우스를 좌상단으로 이동하면 중지',
    'pyautogui.PAUSE = 0.5      # 각 동작 사이 0.5초 대기',
    '',
    'def run():',
  ];

  template.steps.forEach((step, i) => {
    lines.push(`    # Step ${step.order}: ${step.description}`);

    switch (step.automationType) {
      case 'app_launch':
        const appName = step.action.replace('→', '');
        lines.push(`    subprocess.Popen(['open', '-a', '${appName}'])  # macOS`);
        lines.push(`    # subprocess.Popen(['start', '${appName}'], shell=True)  # Windows`);
        lines.push(`    time.sleep(2)`);
        break;

      case 'ui_click':
        const region = step.action.match(/:([LR][TB])$/)?.[1] || '';
        const coords = { LT: '400, 300', RT: '1200, 300', LB: '400, 700', RB: '1200, 700' };
        lines.push(`    # TODO: 정확한 좌표는 스크린샷 분석 후 조정`);
        lines.push(`    pyautogui.click(${coords[region] || '960, 540'})  # ${region || '중앙'}`);
        break;

      case 'keyboard_input':
        lines.push(`    # TODO: 실제 입력 내용은 학습 데이터에서 추출`);
        lines.push(`    pyautogui.typewrite('input_text', interval=0.05)`);
        break;

      case 'clipboard':
        if (step.action === 'copy') {
          lines.push(`    pyautogui.hotkey('ctrl', 'c')  # 복사`);
        } else {
          lines.push(`    pyautogui.hotkey('ctrl', 'v')  # 붙여넣기`);
        }
        break;

      case 'shortcut':
        const keys = step.action.match(/ctrl\+\w|cmd\+\w|alt\+\w/)?.[0] || 'ctrl+s';
        lines.push(`    pyautogui.hotkey('${keys.replace('+', "', '")}')  # ${step.description}`);
        break;

      default:
        lines.push(`    pass  # ${step.action}`);
    }
    lines.push('    time.sleep(0.5)');
    lines.push('');
  });

  lines.push('if __name__ == "__main__":');
  lines.push('    print("Orbit AI 자동화 실행 중...")');
  lines.push('    run()');
  lines.push('    print("완료!")');

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// PowerShell 생성 — Windows COM 자동화 (Excel/Word 등)
// ═══════════════════════════════════════════════════════════════

function generatePowerShell(template) {
  const lines = [
    '# Orbit AI 자동화 스크립트',
    `# ${template.description}`,
    `# 생성: ${new Date().toISOString()}`,
    '',
  ];

  // 앱별 COM 자동화
  const apps = [...new Set(template.steps.map(s => s.action.replace('→', '').split(':')[0]).filter(Boolean))];
  const hasExcel = apps.some(a => /excel/i.test(a));
  const hasWord = apps.some(a => /word|winword/i.test(a));
  const hasPPT = apps.some(a => /powerpnt|powerpoint/i.test(a));

  if (hasExcel) {
    lines.push('# Excel COM 자동화');
    lines.push('$excel = New-Object -ComObject Excel.Application');
    lines.push('$excel.Visible = $true');
    lines.push('$wb = $excel.Workbooks.Open("C:\\path\\to\\file.xlsx")  # TODO: 실제 파일 경로');
    lines.push('$ws = $wb.Sheets(1)');
    lines.push('');
  }

  if (hasWord) {
    lines.push('# Word COM 자동화');
    lines.push('$word = New-Object -ComObject Word.Application');
    lines.push('$word.Visible = $true');
    lines.push('');
  }

  if (hasPPT) {
    lines.push('# PowerPoint COM 자동화');
    lines.push('$ppt = New-Object -ComObject PowerPoint.Application');
    lines.push('$ppt.Visible = [Microsoft.Office.Core.MsoTriState]::msoTrue');
    lines.push('');
  }

  template.steps.forEach((step, i) => {
    lines.push(`# Step ${step.order}: ${step.description}`);

    switch (step.automationType) {
      case 'app_launch':
        lines.push(`Start-Process "${step.action.replace('→', '')}"`);
        lines.push('Start-Sleep -Seconds 2');
        break;

      case 'keyboard_input':
        if (hasExcel) {
          lines.push('# $ws.Range("A1").Value = "데이터"  # TODO: 실제 셀/데이터');
        }
        lines.push('# Add-Type -AssemblyName System.Windows.Forms');
        lines.push('# [System.Windows.Forms.SendKeys]::SendWait("text")');
        break;

      case 'ui_click':
        lines.push('# [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(960, 540)');
        lines.push('# TODO: 정확한 좌표는 학습 데이터에서');
        break;

      default:
        lines.push(`# ${step.action}`);
    }
    lines.push('');
  });

  if (hasExcel) {
    lines.push('# $wb.Save()');
    lines.push('# $excel.Quit()');
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// AutoHotkey 생성 — 키보드/마우스 매크로
// ═══════════════════════════════════════════════════════════════

function generateAutoHotkey(template) {
  const lines = [
    '; Orbit AI 자동화 매크로',
    `; ${template.description}`,
    '; F9로 실행, F10으로 중지',
    '',
    'F9::',
  ];

  template.steps.forEach(step => {
    switch (step.automationType) {
      case 'app_launch':
        lines.push(`Run, ${step.action.replace('→', '')}`);
        lines.push('Sleep, 2000');
        break;
      case 'ui_click':
        lines.push('Click, 960, 540  ; TODO: 좌표 조정');
        break;
      case 'keyboard_input':
        lines.push('SendInput, {Text}input  ; TODO: 실제 입력');
        break;
      case 'clipboard':
        lines.push(step.action === 'copy' ? 'Send, ^c' : 'Send, ^v');
        break;
      case 'shortcut':
        const key = (step.action.match(/ctrl\+(\w)/)?.[1] || 's');
        lines.push(`Send, ^${key}`);
        break;
      default:
        lines.push(`; ${step.description}`);
    }
    lines.push('Sleep, 500');
  });

  lines.push('Return');
  lines.push('');
  lines.push('F10::ExitApp');

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// Power Automate Desktop 생성 (Robin 언어)
// ═══════════════════════════════════════════════════════════════

function generatePowerAutomate(template) {
  const lines = [
    `# Orbit AI — ${template.description}`,
    '# Power Automate Desktop용 (복사 후 PAD에서 붙여넣기)',
    '',
  ];

  template.steps.forEach((step, i) => {
    switch (step.automationType) {
      case 'app_launch':
        lines.push(`System.RunApplication ApplicationPath: "${step.action.replace('→', '')}" WindowStyle: System.ProcessWindowStyle.Normal`);
        lines.push('WAIT 2');
        break;
      case 'ui_click':
        lines.push(`MouseAndKeyboard.SendMouseClick.Click ClickType: MouseAndKeyboard.MouseClickType.LeftClick X: 960 Y: 540`);
        break;
      case 'keyboard_input':
        lines.push(`MouseAndKeyboard.SendKeys.FocusAndSendKeys TextToSend: $'''input''' DelayBetweenKeystrokes: 50`);
        break;
      case 'clipboard':
        if (step.action === 'copy') {
          lines.push(`MouseAndKeyboard.SendKeys.FocusAndSendKeys TextToSend: $'''{Control}({C})'''`);
        } else {
          lines.push(`MouseAndKeyboard.SendKeys.FocusAndSendKeys TextToSend: $'''{Control}({V})'''`);
        }
        break;
      default:
        lines.push(`# ${step.description}`);
    }
  });

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// 스크립트 저장 + 실행
// ═══════════════════════════════════════════════════════════════

/**
 * 템플릿 → 모든 형식의 자동화 스크립트 생성
 */
function generateAll(template) {
  ensureDir();
  const baseName = `orbit-auto-${template.id}`;
  const results = {};

  try {
    const pyPath = path.join(SCRIPTS_DIR, `${baseName}.py`);
    fs.writeFileSync(pyPath, generatePython(template));
    results.python = pyPath;
  } catch {}

  try {
    const ps1Path = path.join(SCRIPTS_DIR, `${baseName}.ps1`);
    fs.writeFileSync(ps1Path, generatePowerShell(template));
    results.powershell = ps1Path;
  } catch {}

  try {
    const ahkPath = path.join(SCRIPTS_DIR, `${baseName}.ahk`);
    fs.writeFileSync(ahkPath, generateAutoHotkey(template));
    results.autohotkey = ahkPath;
  } catch {}

  try {
    const padPath = path.join(SCRIPTS_DIR, `${baseName}.robin`);
    fs.writeFileSync(padPath, generatePowerAutomate(template));
    results.powerAutomate = padPath;
  } catch {}

  console.log(`[automation] 스크립트 생성 완료: ${Object.keys(results).join(', ')}`);
  return results;
}

module.exports = {
  generatePython,
  generatePowerShell,
  generateAutoHotkey,
  generatePowerAutomate,
  generateAll,
  SCRIPTS_DIR,
};
