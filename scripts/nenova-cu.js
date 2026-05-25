#!/usr/bin/env node
'use strict';

/**
 * Nenova Computer Use Lab
 *
 * A local terminal tool for OCR, GUI inspection, Playwright web automation,
 * non-destructive computer-use planning, and GitHub reference ingestion.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { pathToFileURL } = require('url');
const { execFile, execSync } = require('child_process');
const { findClaudeCli } = require('../src/vision-analyzer');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'nenova-cu');
const KNOWLEDGE_FILE = path.join(OUT_DIR, 'github-patterns.json');

const REFERENCE_REPOS = [
  {
    repo: 'microsoft/playwright',
    branch: 'main',
    files: ['README.md'],
    use: 'browser automation, web UI replay, locator strategy',
  },
  {
    repo: 'pywinauto/pywinauto',
    branch: 'master',
    files: ['README.md'],
    use: 'Windows native GUI automation through accessibility/UIA backends',
  },
  {
    repo: 'microsoft/OmniParser',
    branch: 'master',
    files: ['README.md'],
    use: 'screenshot parsing into structured GUI elements',
  },
  {
    repo: 'OpenAdaptAI/OpenAdapt',
    branch: 'main',
    files: ['README.md'],
    use: 'generative process automation and workflow capture patterns',
  },
];

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function printHelp() {
  console.log(`
Nenova Computer Use Lab

Usage:
  node scripts/nenova-cu.js health
  node scripts/nenova-cu.js capture [--out artifacts/nenova-cu/screen.png]
  node scripts/nenova-cu.js ocr [--image path/to/image.png] [--engine best|vision|local]
  node scripts/nenova-cu.js gui
  node scripts/nenova-cu.js desktop-run --click "100,200" [--type "text"] [--hotkey "ctrl+s"] [--execute]
  node scripts/nenova-cu.js preview [--latest 40]
  node scripts/nenova-cu.js web-audit <url> [--headed]
  node scripts/nenova-cu.js web-run <url> --click "text=Login" [--fill "selector=value"]
  node scripts/nenova-cu.js plan --goal "주문 입력 확인" [--url http://localhost:4747]
  node scripts/nenova-cu.js learn-github [owner/repo ...]

Safety:
  - Native desktop actions are dry-run unless --execute is passed.
  - Playwright can operate on web pages only when you explicitly call web-run.
  - GitHub learning stores reference notes locally; it does not train model weights.
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      setArg(args, key, true);
    } else {
      setArg(args, key, next);
      i++;
    }
  }
  return args;
}

function setArg(args, key, value) {
  const normalized = key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  if (args[normalized] === undefined) {
    args[normalized] = value;
  } else if (Array.isArray(args[normalized])) {
    args[normalized].push(value);
  } else {
    args[normalized] = [args[normalized], value];
  }
}

function commandExists(command) {
  try {
    execSync(process.platform === 'win32' ? `where ${command}` : `which ${command}`, {
      stdio: 'ignore',
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: options.timeout || 30000, maxBuffer: options.maxBuffer || 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code || 0,
        error: err?.message || '',
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

async function health() {
  const checks = [];
  checks.push({ name: 'node', ok: true, detail: process.version });
  checks.push({ name: 'python', ok: commandExists('python'), detail: commandExists('python') ? 'available' : 'missing' });
  checks.push({ name: 'powershell', ok: commandExists('powershell'), detail: commandExists('powershell') ? 'available' : 'missing' });
  checks.push({ name: 'tesseract', ok: commandExists('tesseract'), detail: commandExists('tesseract') ? 'available' : 'optional missing' });

  let pyautogui = false;
  let pillow = false;
  if (commandExists('python')) {
    const py = await run('python', ['-c', "import importlib.util; print('pyautogui=' + str(importlib.util.find_spec('pyautogui') is not None)); print('PIL=' + str(importlib.util.find_spec('PIL') is not None))"]);
    pyautogui = /pyautogui=True/.test(py.stdout);
    pillow = /PIL=True/.test(py.stdout);
  }
  checks.push({ name: 'pyautogui', ok: pyautogui, detail: pyautogui ? 'available' : 'pip install pyautogui' });
  checks.push({ name: 'pillow', ok: pillow, detail: pillow ? 'available' : 'pip install pillow' });

  let playwright = false;
  try {
    require.resolve('playwright');
    playwright = true;
  } catch {
    try {
      require.resolve('@playwright/test');
      playwright = true;
    } catch {}
  }
  checks.push({ name: 'playwright', ok: playwright, detail: playwright ? 'available' : 'npm install playwright' });

  let winOcr = false;
  if (process.platform === 'win32' && commandExists('powershell')) {
    const ps = await run('powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "try { Add-Type -AssemblyName System.Runtime.WindowsRuntime; [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null; if ([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages.Count -gt 0) { 'OK' } } catch { 'NO' }",
    ]);
    winOcr = /OK/.test(ps.stdout);
  }
  checks.push({ name: 'windows-ocr', ok: winOcr, detail: winOcr ? 'available' : 'optional missing' });
  const claudePath = String(findClaudeCli() || '').trim();
  checks.push({ name: 'claude-vision', ok: !!claudePath, detail: claudePath || 'claude CLI missing or not on PATH' });

  console.log(JSON.stringify({ ok: checks.every((c) => c.ok || ['tesseract', 'windows-ocr', 'claude-vision'].includes(c.name)), checks }, null, 2));
}

async function capture(args) {
  ensureOutDir();
  const out = path.resolve(args.out || path.join(OUT_DIR, `screen-${Date.now()}.png`));
  const py = `
import sys
try:
    import pyautogui
    img = pyautogui.screenshot()
    img.save(sys.argv[1])
    print(sys.argv[1])
except Exception as e:
    print("ERROR:" + str(e))
    sys.exit(1)
`;
  const result = await run('python', ['-c', py, out], { timeout: 20000 });
  if (!result.ok) throw new Error(result.stderr || result.stdout || result.error);
  if (!args.silent) console.log(JSON.stringify({ ok: true, image: out }, null, 2));
  return out;
}

async function ocr(args) {
  const result = await runOcr(args);
  console.log(JSON.stringify({
    ok: true,
    image: result.image,
    output: result.output,
    engine: result.engine,
    enginesTried: result.enginesTried,
    textPreview: String(result.text || '').slice(0, 500),
    lineCount: result.lines.length,
    fields: result.nenova?.fields || {},
    corrections: result.nenova?.corrections || [],
  }, null, 2));
}

async function runOcr(args) {
  ensureOutDir();
  const image = args.image ? path.resolve(args.image) : await capture({ out: path.join(OUT_DIR, `ocr-${Date.now()}.png`), silent: true });
  if (!fs.existsSync(image)) throw new Error(`image not found: ${image}`);

  let result = null;
  const engine = String(args.engine || 'best').toLowerCase();
  const enginesTried = [];
  if ((engine === 'best' || engine === 'vision' || engine === 'claude') && !args.noVision) {
    enginesTried.push('claude-vision');
    result = await ocrClaudeVision(image, args);
    if (result && !String(result.text || '').trim() && result.warning && engine === 'best') {
      result = null;
    }
  }
  if (!result && (engine === 'best' || engine === 'local' || engine === 'tesseract') && commandExists('tesseract')) {
    enginesTried.push('tesseract');
    result = await ocrTesseract(image);
  }
  if (!result && (engine === 'best' || engine === 'local' || engine === 'windows') && process.platform === 'win32' && commandExists('powershell')) {
    enginesTried.push('windows-ocr');
    result = await ocrWindows(image);
  }
  if (!result) {
    result = {
      engine: 'none',
      text: '',
      lines: [],
      warning: 'No OCR engine available. Install Tesseract or enable Windows OCR language pack.',
    };
  }

  const out = path.join(OUT_DIR, `ocr-${Date.now()}.json`);
  const text = String(result.text || '');
  const lines = Array.isArray(result.lines) ? result.lines : [];
  const nenova = enhanceNenovaOcr(text, lines, result);
  const payload = { ok: true, image, ...result, text: nenova.correctedText, rawText: text, lines, nenova, enginesTried };
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
  return { ...payload, output: out };
}

async function ocrClaudeVision(image, args = {}) {
  const claude = findClaudeCli();
  if (!claude) return null;
  const prompt = `You are the OCR and GUI parsing engine for a Korean SME operations system called Nenova.
Read this screenshot with maximum precision. Prefer exact visible text over interpretation.
Return JSON only:
{
  "engine": "claude-vision",
  "text": "all visible text in natural reading order",
  "lines": [{"text":"line text","role":"title|label|value|button|table|unknown"}],
  "fields": {
    "customer": "",
    "orderNo": "",
    "product": "",
    "quantity": "",
    "date": "",
    "amount": "",
    "screen": "",
    "app": ""
  },
  "guiElements": [{"label":"visible label","type":"button|input|table|menu|link|unknown","confidence":0.0}],
  "businessIntent": "what work is likely being done",
  "confidence": 0.0
}

Nenova vocabulary: 거래처, 고객명, 주문번호, 품목, 품명, 수량, 단가, 금액, 출고, 입고, 발주, 재고, 차수, 카카오톡, 네노바, 화훼.`;
  const result = await run(claude, ['-p', prompt, '--output-format', 'json', image], {
    timeout: Number(args.visionTimeout || 90000),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (!result.ok) {
    return { engine: 'claude-vision', text: '', lines: [], warning: result.stderr || result.error };
  }
  try {
    const outer = JSON.parse(result.stdout);
    const text = outer.result || outer.content?.[0]?.text || result.stdout;
    const jsonMatch = String(text).match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : outer;
    return {
      engine: 'claude-vision',
      text: String(parsed.text || ''),
      lines: Array.isArray(parsed.lines) ? parsed.lines : [],
      fields: parsed.fields || {},
      guiElements: Array.isArray(parsed.guiElements) ? parsed.guiElements : [],
      businessIntent: parsed.businessIntent || '',
      confidence: Number(parsed.confidence || 0),
    };
  } catch (e) {
    return { engine: 'claude-vision', text: '', lines: [], warning: `parse failed: ${e.message}` };
  }
}

async function ocrTesseract(image) {
  const result = await run('tesseract', [image, 'stdout', '-l', 'kor+eng', '--psm', '6'], { timeout: 60000 });
  if (!result.ok || !result.stdout.trim()) return null;
  const lines = result.stdout.split(/\r?\n/).map((text) => text.trim()).filter(Boolean).map((text, index) => ({ index, text }));
  return { engine: 'tesseract', text: result.stdout.trim(), lines };
}

async function ocrWindows(image) {
  const psPath = path.join(OUT_DIR, 'win-ocr.ps1');
  const ps = `
param([string]$ImagePath)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 })[0]
function Await($operation, $type) {
  $asTask = $asTaskGeneric.MakeGenericMethod($type)
  $task = $asTask.Invoke($null, @($operation))
  $task.Wait() | Out-Null
  return $task.Result
}
$storageFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await ($storageFile.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bitmap, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw "Windows OCR engine unavailable" }
$ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$items = @()
foreach ($line in $ocr.Lines) {
  $words = @()
  foreach ($word in $line.Words) {
    $words += [ordered]@{
      text = $word.Text
      x = [int]$word.BoundingRect.X
      y = [int]$word.BoundingRect.Y
      width = [int]$word.BoundingRect.Width
      height = [int]$word.BoundingRect.Height
    }
  }
  $items += [ordered]@{ text = $line.Text; words = $words }
}
[ordered]@{ engine = 'windows-ocr'; text = $ocr.Text; lines = $items } | ConvertTo-Json -Depth 8
`;
  fs.writeFileSync(psPath, ps, 'utf8');
  const result = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath, image], {
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!result.ok || !result.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    parsed.lines = Array.isArray(parsed.lines) ? parsed.lines : [];
    return parsed;
  } catch {
    return null;
  }
}

const NENOVA_OCR_CORRECTIONS = [
  [/거래서/g, '거래처'],
  [/거레처/g, '거래처'],
  [/고객멍/g, '고객명'],
  [/주문번 호/g, '주문번호'],
  [/품 목/g, '품목'],
  [/수 량/g, '수량'],
  [/네 노바/g, '네노바'],
  [/오르빗/g, 'Orbit'],
];

function enhanceNenovaOcr(text, lines = [], engineResult = {}) {
  const corrections = [];
  let correctedText = String(text || '');
  for (const [pattern, replacement] of NENOVA_OCR_CORRECTIONS) {
    if (pattern.test(correctedText)) {
      corrections.push({ pattern: String(pattern), replacement });
      correctedText = correctedText.replace(pattern, replacement);
    }
  }
  const fieldText = `${correctedText}\n${Object.values(engineResult.fields || {}).join('\n')}`;
  const fields = {
    customer: pickField(fieldText, ['거래처', '고객명', 'customer']),
    orderNo: pickField(fieldText, ['주문번호', 'order', 'orderNo']),
    product: pickField(fieldText, ['품목', '품명', 'product']),
    quantity: pickField(fieldText, ['수량', 'qty', 'quantity']),
    date: pickDate(fieldText),
    amount: pickAmount(fieldText),
    screen: engineResult.fields?.screen || detectScreen(fieldText),
    app: engineResult.fields?.app || detectApp(fieldText),
  };
  const vocabularyHits = ['거래처', '고객명', '주문번호', '품목', '품명', '수량', '단가', '금액', '출고', '입고', '발주', '재고', '차수', '카카오톡', '네노바']
    .filter((term) => fieldText.includes(term));
  const lineItems = extractLineItems(correctedText, lines);
  return {
    correctedText,
    corrections,
    fields,
    vocabularyHits,
    lineItems,
    businessIntent: engineResult.businessIntent || inferBusinessIntent(fieldText),
    guiElements: engineResult.guiElements || [],
  };
}

function pickField(text, labels) {
  for (const label of labels) {
    const safe = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`${safe}\\s*[:：=]\\s*([^\\n\\r|,;]+)`, 'i'),
      new RegExp(`${safe}\\s+([^\\n\\r|,;]{2,40})`, 'i'),
    ];
    for (const pattern of patterns) {
      const match = String(text).match(pattern);
      if (match?.[1]) return match[1].trim();
    }
  }
  return '';
}

function pickDate(text) {
  const match = String(text).match(/20\d{2}[-./년\s]\d{1,2}[-./월\s]\d{1,2}/);
  return match ? match[0].replace(/[년월\s.]/g, '-').replace(/--+/g, '-') : '';
}

function pickAmount(text) {
  const match = String(text).match(/(?:금액|합계|amount)\s*[:：=]?\s*([0-9,]+)\s*(?:원)?/i);
  return match ? match[1] : '';
}

function detectScreen(text) {
  if (/주문|order/i.test(text)) return 'order';
  if (/출고|shipment/i.test(text)) return 'shipment';
  if (/입고|발주|purchase/i.test(text)) return 'purchase';
  if (/재고|stock|inventory/i.test(text)) return 'inventory';
  if (/카카오|kakao/i.test(text)) return 'kakao';
  return '';
}

function detectApp(text) {
  if (/네노바|nenova/i.test(text)) return 'nenova';
  if (/chrome|edge|브라우저/i.test(text)) return 'browser';
  if (/excel|엑셀/i.test(text)) return 'excel';
  if (/카카오|kakao/i.test(text)) return 'kakao';
  return '';
}

function inferBusinessIntent(text) {
  const screen = detectScreen(text);
  if (screen === 'order') return '주문 입력/조회/수정 업무';
  if (screen === 'shipment') return '출고/배송 확인 업무';
  if (screen === 'purchase') return '입고/발주 확인 업무';
  if (screen === 'inventory') return '재고 확인 업무';
  if (screen === 'kakao') return '대화 기반 업무 접수/확인';
  return '업무 화면 인식';
}

function extractLineItems(text, lines = []) {
  const sourceLines = lines.length
    ? lines.map((line) => String(line.text || line).trim()).filter(Boolean)
    : String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return sourceLines
    .filter((line) => /[가-힣A-Za-z].*\d+/.test(line) && /(단|개|박스|송이|묶음|본|EA|BOX|qty|수량)/i.test(line))
    .slice(0, 30)
    .map((line) => {
      const qty = line.match(/(\d+(?:,\d{3})*)\s*(단|개|박스|송이|묶음|본|EA|BOX)?/i);
      return { raw: line, quantity: qty?.[1] || '', unit: qty?.[2] || '' };
    });
}

async function desktopRun(args) {
  ensureOutDir();
  const actions = parseDesktopActions(args);
  if (!actions.length) throw new Error('desktop-run requires --click, --type, --hotkey, or --wait');
  const execute = !!args.execute;
  const before = await capture({ out: path.join(OUT_DIR, `desktop-before-${Date.now()}.png`), silent: true });

  if (!execute) {
    const out = path.join(OUT_DIR, `desktop-dry-run-${Date.now()}.json`);
    const payload = {
      ok: true,
      executed: false,
      before,
      actions,
      message: 'Dry-run only. Add --execute to perform local desktop actions.',
    };
    fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
    console.log(JSON.stringify({ ...payload, output: out }, null, 2));
    return;
  }

  const result = await runDesktopActions(actions);
  const after = await capture({ out: path.join(OUT_DIR, `desktop-after-${Date.now()}.png`), silent: true });
  const afterOcr = await runOcr({ image: after, engine: args.ocrEngine || 'best', noVision: args.noVision });
  const out = path.join(OUT_DIR, `desktop-run-${Date.now()}.json`);
  const payload = { ok: result.ok, executed: true, before, after, actions, stdout: result.stdout, stderr: result.stderr, afterOcr };
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: result.ok,
    executed: true,
    output: out,
    before,
    after,
    actionCount: actions.length,
    afterTextPreview: String(afterOcr.text || '').slice(0, 300),
  }, null, 2));
}

function parseDesktopActions(args) {
  const actions = [];
  if (args.click) {
    for (const click of asArray(args.click)) {
      const [x, y] = String(click).split(',').map((v) => Number.parseInt(v.trim(), 10));
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`invalid --click "${click}". Use "x,y".`);
      actions.push({ type: 'click', x, y });
    }
  }
  if (args.type) actions.push({ type: 'type', text: String(args.type) });
  if (args.hotkey) {
    for (const hotkey of asArray(args.hotkey)) {
      actions.push({ type: 'hotkey', keys: String(hotkey).split('+').map((k) => k.trim()).filter(Boolean) });
    }
  }
  if (args.wait) actions.push({ type: 'wait', ms: Math.max(0, Number.parseInt(args.wait, 10) || 0) });
  return actions;
}

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

async function runDesktopActions(actions) {
  const script = `
import json, subprocess, sys, time
import pyautogui
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.15
actions = json.loads(sys.argv[1])
for action in actions:
    kind = action.get("type")
    if kind == "click":
        pyautogui.click(int(action["x"]), int(action["y"]))
    elif kind == "type":
        text = str(action.get("text", ""))
        try:
            subprocess.run(["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $args[0]", text], check=True, timeout=5)
            pyautogui.hotkey("ctrl", "v")
        except Exception:
            pyautogui.write(text, interval=0.01)
    elif kind == "hotkey":
        pyautogui.hotkey(*action.get("keys", []))
    elif kind == "wait":
        time.sleep(max(0, int(action.get("ms", 0))) / 1000)
print("ok")
`;
  return run('python', ['-c', script, JSON.stringify(actions)], { timeout: 60000 });
}

async function gui() {
  const windows = await getWindows();
  const focused = windows[0] || null;
  const out = path.join(OUT_DIR, `gui-${Date.now()}.json`);
  ensureOutDir();
  fs.writeFileSync(out, JSON.stringify({ ok: true, windows, focused, actionMode: 'inspect-only' }, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, output: out, count: windows.length, windows: windows.slice(0, 20) }, null, 2));
}

async function getWindows() {
  if (process.platform !== 'win32' || !commandExists('powershell')) return [];
  const ps = `
Get-Process |
  Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim().Length -gt 0 } |
  Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle |
  ConvertTo-Json -Depth 4
`;
  const result = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
  if (!result.ok || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((w) => ({
      pid: w.Id,
      process: w.ProcessName,
      title: w.MainWindowTitle,
      handle: w.MainWindowHandle,
    }));
  } catch {
    return [];
  }
}

async function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    const test = require('@playwright/test');
    return test;
  }
}

async function webAudit(url, args = {}) {
  ensureOutDir();
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: !args.headed });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const started = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const title = await page.title();
  const elements = await page.locator('a,button,input,textarea,select,[role="button"],[contenteditable="true"]').evaluateAll((nodes) =>
    nodes.slice(0, 200).map((node, index) => {
      const rect = node.getBoundingClientRect();
      const label = node.innerText || node.value || node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.getAttribute('title') || node.id || node.name || '';
      return {
        index,
        tag: node.tagName.toLowerCase(),
        type: node.getAttribute('type') || '',
        label: String(label).replace(/\\s+/g, ' ').trim().slice(0, 120),
        id: node.id || '',
        name: node.getAttribute('name') || '',
        role: node.getAttribute('role') || '',
        visible: rect.width > 0 && rect.height > 0,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    })
  );
  const screenshot = path.join(OUT_DIR, `web-${Date.now()}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await browser.close();
  const audit = {
    ok: true,
    url,
    title,
    elapsedMs: Date.now() - started,
    screenshot,
    elements,
    actionMode: 'web-inspect',
  };
  const out = path.join(OUT_DIR, `web-audit-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(audit, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, output: out, title, elapsedMs: audit.elapsedMs, elementCount: elements.length, screenshot }, null, 2));
}

async function webRun(url, args = {}) {
  if (!args.click && !args.fill) throw new Error('web-run requires --click or --fill');
  ensureOutDir();
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: !args.headed });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const steps = [];
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (args.fill) {
    const [selector, value] = splitOnce(args.fill, '=');
    await page.locator(selector).first().fill(value || '');
    steps.push({ action: 'fill', selector, valueLength: (value || '').length });
  }
  if (args.click) {
    const [kind, value] = splitOnce(args.click, '=');
    if (kind === 'text') {
      await page.getByText(value, { exact: false }).first().click();
      steps.push({ action: 'click', by: 'text', value });
    } else {
      await page.locator(args.click).first().click();
      steps.push({ action: 'click', by: 'selector', value: args.click });
    }
  }
  const screenshot = path.join(OUT_DIR, `web-run-${Date.now()}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await browser.close();
  console.log(JSON.stringify({ ok: true, url, steps, screenshot }, null, 2));
}

function splitOnce(value, sep) {
  const index = String(value).indexOf(sep);
  if (index === -1) return [value, ''];
  return [String(value).slice(0, index), String(value).slice(index + sep.length)];
}

async function preview(args = {}) {
  ensureOutDir();
  const latest = Math.max(1, Math.min(200, Number.parseInt(args.latest, 10) || 60));
  const frames = collectPreviewFrames(latest);
  const out = path.join(OUT_DIR, 'preview.html');
  fs.writeFileSync(out, buildPreviewHtml(frames), 'utf8');
  console.log(JSON.stringify({
    ok: true,
    output: out,
    url: pathToFileURL(out).href,
    frameCount: frames.length,
    message: 'Open the output HTML to watch the OCR/GUI/Web replay timeline.',
  }, null, 2));
}

function collectPreviewFrames(limit) {
  if (!fs.existsSync(OUT_DIR)) return [];
  const files = fs.readdirSync(OUT_DIR)
    .filter((name) => name.endsWith('.json') && !['github-patterns.json'].includes(name))
    .map((name) => {
      const file = path.join(OUT_DIR, name);
      return { name, file, mtime: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime)
    .slice(-limit);

  const frames = [];
  for (const item of files) {
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(item.file, 'utf8'));
    } catch {
      continue;
    }
    frames.push(...framesFromArtifact(item, data));
  }
  return frames.map((frame, index) => ({ ...frame, index }));
}

function framesFromArtifact(item, data) {
  const frames = [];
  if (data.image && (data.rawText !== undefined || data.text !== undefined || data.nenova)) {
    frames.push({
      kind: 'ocr',
      title: `OCR 분석: ${item.name}`,
      source: item.name,
      image: assetSrc(data.image),
      overlays: ocrOverlays(data),
      side: {
        engine: data.engine,
        text: data.text || data.rawText || '',
        fields: data.nenova?.fields || data.fields || {},
        corrections: data.nenova?.corrections || [],
        intent: data.nenova?.businessIntent || data.businessIntent || '',
      },
    });
  }
  if (data.before && Array.isArray(data.actions)) {
    frames.push({
      kind: data.executed ? 'desktop-before' : 'desktop-dry-run',
      title: `${data.executed ? 'Desktop 실행 전' : 'Desktop Dry-run'}: ${item.name}`,
      source: item.name,
      image: assetSrc(data.before),
      overlays: desktopOverlays(data.actions),
      side: {
        executed: !!data.executed,
        actions: data.actions,
        message: data.message || '',
      },
    });
  }
  if (data.after) {
    frames.push({
      kind: 'desktop-after',
      title: `Desktop 실행 후: ${item.name}`,
      source: item.name,
      image: assetSrc(data.after),
      overlays: ocrOverlays(data.afterOcr || {}),
      side: {
        executed: !!data.executed,
        afterText: data.afterOcr?.text || '',
        fields: data.afterOcr?.nenova?.fields || {},
      },
    });
  }
  if (data.screenshot && Array.isArray(data.elements)) {
    frames.push({
      kind: 'web-audit',
      title: `Web 요소 분석: ${data.title || item.name}`,
      source: item.name,
      image: assetSrc(data.screenshot),
      overlays: webElementOverlays(data.elements),
      side: {
        url: data.url,
        title: data.title,
        elementCount: data.elements.length,
      },
    });
  }
  if (data.screenshot && Array.isArray(data.steps)) {
    frames.push({
      kind: 'web-run',
      title: `Web 실행 결과: ${item.name}`,
      source: item.name,
      image: assetSrc(data.screenshot),
      overlays: [],
      side: {
        url: data.url,
        steps: data.steps,
      },
    });
  }
  return frames;
}

function assetSrc(file) {
  if (!file) return '';
  const absolute = path.resolve(file);
  const rel = path.relative(OUT_DIR, absolute);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
  return pathToFileURL(absolute).href;
}

function ocrOverlays(data) {
  const overlays = [];
  const lines = Array.isArray(data.lines) ? data.lines : [];
  for (const line of lines) {
    const words = Array.isArray(line.words) ? line.words : [];
    for (const word of words) {
      if (Number.isFinite(word.x) && Number.isFinite(word.y)) {
        overlays.push({
          type: 'ocr-word',
          x: word.x,
          y: word.y,
          w: word.width || 24,
          h: word.height || 18,
          label: word.text || line.text || 'OCR',
        });
      }
    }
  }
  const guiElements = data.guiElements || data.nenova?.guiElements || [];
  for (const element of guiElements) {
    const rect = element.rect || element.box || element.bbox;
    if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y)) {
      overlays.push({
        type: 'gui-element',
        x: rect.x,
        y: rect.y,
        w: rect.width || rect.w || 80,
        h: rect.height || rect.h || 28,
        label: element.label || element.text || element.type || 'GUI',
      });
    }
  }
  return overlays;
}

function desktopOverlays(actions) {
  return actions.flatMap((action, actionIndex) => {
    if (action.type === 'click') {
      return [{
        type: 'click',
        x: action.x - 22,
        y: action.y - 22,
        w: 44,
        h: 44,
        label: `click ${actionIndex + 1}`,
      }];
    }
    return [{
      type: action.type || 'action',
      x: 18,
      y: 18 + actionIndex * 42,
      w: 280,
      h: 32,
      label: action.type === 'type' ? `type: ${String(action.text || '').slice(0, 40)}` : JSON.stringify(action),
      fixed: true,
    }];
  });
}

function webElementOverlays(elements) {
  return elements
    .filter((element) => element.visible !== false && element.rect)
    .slice(0, 120)
    .map((element) => ({
      type: element.tag === 'button' ? 'button' : 'web-element',
      x: element.rect.x,
      y: element.rect.y,
      w: element.rect.width,
      h: element.rect.height,
      label: element.label || element.id || element.name || element.tag,
    }));
}

function buildPreviewHtml(frames) {
  const dataJson = JSON.stringify(frames).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nenova Computer Use Preview</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; background: #0d1117; color: #d6dde7; font-family: "Segoe UI", Arial, sans-serif; }
.app { min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 18px; border-bottom: 1px solid #263242; background: #111821; }
h1 { font-size: 17px; margin: 0; font-weight: 650; }
.controls { display: flex; gap: 8px; align-items: center; }
button { border: 1px solid #3a4b61; background: #172231; color: #edf4ff; padding: 8px 11px; border-radius: 6px; cursor: pointer; }
button:hover { background: #213149; }
.main { display: grid; grid-template-columns: minmax(0, 1fr) 360px; min-height: 0; }
.stage { position: relative; min-height: 0; overflow: auto; padding: 18px; background: radial-gradient(circle at center, #111a24 0, #0d1117 70%); }
.canvasWrap { position: relative; display: inline-block; max-width: 100%; background: #05070a; border: 1px solid #263242; }
#shot { display: block; max-width: min(100%, 1500px); height: auto; }
#overlay { position: absolute; inset: 0; pointer-events: none; }
.box { position: absolute; border: 2px solid #42d392; background: rgba(66, 211, 146, .1); color: #001b10; }
.box.click { border-radius: 999px; border-color: #ffcc66; background: rgba(255, 204, 102, .18); }
.box.click::before, .box.click::after { content: ""; position: absolute; background: #ffcc66; left: 50%; top: 50%; transform: translate(-50%, -50%); }
.box.click::before { width: 2px; height: 52px; }
.box.click::after { width: 52px; height: 2px; }
.box.web-element { border-color: #77aaff; background: rgba(119, 170, 255, .12); }
.box.button { border-color: #ff8c7a; background: rgba(255, 140, 122, .14); }
.box.gui-element { border-color: #c995ff; background: rgba(201, 149, 255, .14); }
.box.action { border-color: #f0c36a; background: rgba(240, 195, 106, .22); }
.tag { position: absolute; left: 0; top: -24px; max-width: 280px; padding: 3px 6px; border-radius: 4px; background: #edf4ff; color: #111821; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
aside { border-left: 1px solid #263242; background: #111821; min-width: 0; overflow: auto; padding: 16px; }
.meta { color: #8da2bd; font-size: 12px; margin-bottom: 10px; }
.panelTitle { margin: 0 0 8px; font-size: 15px; color: #f2f7ff; }
pre { white-space: pre-wrap; word-break: break-word; background: #0d1117; border: 1px solid #263242; border-radius: 6px; padding: 10px; max-height: 360px; overflow: auto; }
.timeline { display: flex; gap: 8px; overflow-x: auto; border-top: 1px solid #263242; background: #111821; padding: 10px; }
.thumb { flex: 0 0 190px; border: 1px solid #2b384a; background: #0d1117; color: #d6dde7; border-radius: 6px; padding: 8px; text-align: left; cursor: pointer; }
.thumb.active { border-color: #42d392; box-shadow: 0 0 0 1px #42d392 inset; }
.thumb strong { display: block; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.thumb span { display: block; color: #8da2bd; font-size: 11px; margin-top: 4px; }
.empty { margin: 28px; padding: 18px; border: 1px solid #263242; background: #111821; border-radius: 8px; color: #9fb2c8; }
@media (max-width: 980px) { .main { grid-template-columns: 1fr; } aside { border-left: 0; border-top: 1px solid #263242; } }
</style>
</head>
<body>
<div class="app">
  <header>
    <h1>Nenova Computer Use Preview</h1>
    <div class="controls">
      <button id="prev">Prev</button>
      <button id="play">Play</button>
      <button id="next">Next</button>
      <span id="count" class="meta"></span>
    </div>
  </header>
  <div class="main">
    <section class="stage">
      <div id="empty" class="empty" hidden>아직 표시할 작업 기록이 없습니다. ocr, desktop-run, web-audit을 먼저 실행하세요.</div>
      <div class="canvasWrap" id="wrap">
        <img id="shot" alt="preview frame">
        <div id="overlay"></div>
      </div>
    </section>
    <aside>
      <div class="meta" id="source"></div>
      <h2 class="panelTitle" id="title"></h2>
      <pre id="details"></pre>
    </aside>
  </div>
  <div class="timeline" id="timeline"></div>
</div>
<script>
const frames = ${dataJson};
let current = 0;
let timer = null;
const shot = document.getElementById('shot');
const wrap = document.getElementById('wrap');
const overlay = document.getElementById('overlay');
const details = document.getElementById('details');
const title = document.getElementById('title');
const source = document.getElementById('source');
const count = document.getElementById('count');
const timeline = document.getElementById('timeline');
const empty = document.getElementById('empty');

function renderTimeline() {
  timeline.innerHTML = '';
  frames.forEach((frame, index) => {
    const item = document.createElement('button');
    item.className = 'thumb' + (index === current ? ' active' : '');
    item.innerHTML = '<strong>' + escapeHtml(frame.title || frame.kind) + '</strong><span>' + escapeHtml(frame.kind || '') + '</span>';
    item.onclick = () => { current = index; render(); };
    timeline.appendChild(item);
  });
}

function render() {
  if (!frames.length) {
    wrap.hidden = true;
    empty.hidden = false;
    count.textContent = '0 / 0';
    return;
  }
  wrap.hidden = false;
  empty.hidden = true;
  const frame = frames[current];
  shot.src = frame.image || '';
  title.textContent = frame.title || frame.kind || '';
  source.textContent = frame.source || '';
  count.textContent = (current + 1) + ' / ' + frames.length;
  details.textContent = JSON.stringify(frame.side || {}, null, 2);
  shot.onload = drawOverlay;
  drawOverlay();
  renderTimeline();
}

function drawOverlay() {
  overlay.innerHTML = '';
  const frame = frames[current];
  if (!frame || !shot.naturalWidth) return;
  const scaleX = shot.clientWidth / shot.naturalWidth;
  const scaleY = shot.clientHeight / shot.naturalHeight;
  overlay.style.width = shot.clientWidth + 'px';
  overlay.style.height = shot.clientHeight + 'px';
  for (const item of frame.overlays || []) {
    const box = document.createElement('div');
    box.className = 'box ' + (item.type || 'action');
    box.style.left = Math.round(item.x * scaleX) + 'px';
    box.style.top = Math.round(item.y * scaleY) + 'px';
    box.style.width = Math.max(8, Math.round((item.w || 24) * scaleX)) + 'px';
    box.style.height = Math.max(8, Math.round((item.h || 18) * scaleY)) + 'px';
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = item.label || item.type || '';
    box.appendChild(tag);
    overlay.appendChild(box);
  }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

document.getElementById('prev').onclick = () => { current = (current - 1 + frames.length) % frames.length; render(); };
document.getElementById('next').onclick = () => { current = (current + 1) % frames.length; render(); };
document.getElementById('play').onclick = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
    document.getElementById('play').textContent = 'Play';
    return;
  }
  document.getElementById('play').textContent = 'Pause';
  timer = setInterval(() => { current = (current + 1) % frames.length; render(); }, 1300);
};
window.addEventListener('resize', drawOverlay);
render();
</script>
</body>
</html>`;
}

async function plan(args) {
  ensureOutDir();
  const goal = args.goal || args._.slice(1).join(' ');
  if (!goal) throw new Error('--goal is required');
  const windows = await getWindows();
  const knowledge = loadKnowledge();
  const planDoc = {
    ok: true,
    mode: 'computer-use-plan',
    executionEnabled: false,
    goal,
    url: args.url || null,
    observedWindows: windows.slice(0, 10),
    learnedReferences: knowledge.sources?.map((s) => ({ repo: s.repo, use: s.use, learnedAt: s.learnedAt })) || [],
    steps: [
      { id: 'observe', tool: 'capture + ocr + gui', purpose: '현재 화면과 활성 앱 상태를 읽는다.' },
      { id: 'target', tool: args.url ? 'playwright locator' : 'windows gui map', purpose: '클릭/입력 후보를 찾는다.' },
      { id: 'act', tool: args.url ? 'web-run' : 'desktop-run --execute', purpose: '웹/데스크톱 모두 명시 명령일 때만 실행한다.' },
      { id: 'verify', tool: 'screenshot + ocr + web-audit', purpose: '실행 전후 결과를 캡처해 비교한다.' },
    ],
    safety: [
      'Native desktop GUI is dry-run unless --execute is passed.',
      'Employee PC daemon queues are not used.',
      'Use web-run only for explicit browser actions.',
    ],
  };
  const out = path.join(OUT_DIR, `plan-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(planDoc, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, output: out, stepCount: planDoc.steps.length, learnedReferences: planDoc.learnedReferences.length }, null, 2));
}

function loadKnowledge() {
  try {
    return JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
  } catch {
    return { sources: [] };
  }
}

async function learnGithub(args) {
  ensureOutDir();
  const requested = args._.slice(1);
  const repos = requested.length
    ? requested.map((repo) => ({ repo, branch: 'main', files: ['README.md'], use: 'user supplied GitHub reference' }))
    : REFERENCE_REPOS;
  const sources = [];
  for (const item of repos) {
    const source = await ingestRepo(item);
    sources.push(source);
  }
  const knowledge = {
    learnedAt: new Date().toISOString(),
    note: 'Reference ingestion only. This stores design patterns and terms; it does not train model weights.',
    sources,
    synthesizedPatterns: synthesizePatterns(sources),
  };
  fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(knowledge, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, output: KNOWLEDGE_FILE, sources: sources.map((s) => ({ repo: s.repo, ok: s.ok, bytes: s.bytes })) }, null, 2));
}

async function ingestRepo(item) {
  const files = [];
  let bytes = 0;
  let ok = false;
  let lastError = '';
  for (const file of item.files) {
    const url = `https://raw.githubusercontent.com/${item.repo}/${item.branch || 'main'}/${file}`;
    try {
      const text = await fetchText(url);
      bytes += Buffer.byteLength(text);
      ok = true;
      files.push({
        path: file,
        url,
        summary: summarizeReadme(text),
      });
    } catch (e) {
      lastError = e.message;
      if ((item.branch || 'main') === 'main') {
        try {
          const fallbackUrl = `https://raw.githubusercontent.com/${item.repo}/master/${file}`;
          const text = await fetchText(fallbackUrl);
          bytes += Buffer.byteLength(text);
          ok = true;
          files.push({ path: file, url: fallbackUrl, summary: summarizeReadme(text) });
        } catch (fallbackError) {
          lastError = fallbackError.message;
        }
      }
    }
  }
  return {
    repo: item.repo,
    use: item.use,
    ok,
    bytes,
    error: ok ? null : lastError,
    learnedAt: new Date().toISOString(),
    files,
  };
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'nenova-cu' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchText(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} ${url}`));
        res.resume();
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject).setTimeout(30000, function onTimeout() {
      this.destroy(new Error(`timeout ${url}`));
    });
  });
}

function summarizeReadme(text) {
  const headings = [...String(text).matchAll(/^#{1,3}\s+(.+)$/gm)].slice(0, 20).map((m) => m[1].trim());
  const lower = String(text).toLowerCase();
  const keywords = ['ocr', 'screenshot', 'gui', 'automation', 'playwright', 'locator', 'uia', 'accessibility', 'agent', 'workflow']
    .filter((term) => lower.includes(term));
  return {
    chars: text.length,
    headings,
    keywords,
    excerpt: String(text).replace(/\s+/g, ' ').slice(0, 900),
  };
}

function synthesizePatterns(sources) {
  return [
    {
      name: 'Observe before acting',
      from: sources.filter((s) => s.ok).map((s) => s.repo),
      rule: 'Screenshot/OCR/DOM/UIA evidence should be captured before any automation action.',
    },
    {
      name: 'Prefer semantic locators',
      from: ['microsoft/playwright', 'pywinauto/pywinauto'],
      rule: 'Use text, role, automation id, and accessibility metadata before raw coordinates.',
    },
    {
      name: 'Use vision parsing when accessibility is weak',
      from: ['microsoft/OmniParser'],
      rule: 'When GUI metadata is unavailable, convert screenshots into structured elements with boxes and labels.',
    },
    {
      name: 'Record and replay workflows',
      from: ['OpenAdaptAI/OpenAdapt'],
      rule: 'Workflow capture should become reusable process knowledge, not one-off scripts.',
    },
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (!command || command === 'help' || args.help) return printHelp();
    if (command === 'health') return await health();
    if (command === 'capture') return await capture(args);
    if (command === 'ocr') return await ocr(args);
    if (command === 'gui') return await gui(args);
    if (command === 'desktop-run') return await desktopRun(args);
    if (command === 'preview') return await preview(args);
    if (command === 'web-audit') return await webAudit(args._[1], args);
    if (command === 'web-run') return await webRun(args._[1], args);
    if (command === 'plan') return await plan(args);
    if (command === 'learn-github') return await learnGithub(args);
    throw new Error(`unknown command: ${command}`);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }, null, 2));
    process.exitCode = 1;
  }
}

main();
