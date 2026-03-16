'use strict';

/**
 * screen-capture.js
 * ---------------------------------------------------------------------------
 * Periodic screenshot -> file path (NO content analysis yet)
 * Just captures and stores locally. Server-side Vision API analysis is future work.
 *
 * - macOS: screencapture (built-in)
 * - Linux: scrot or gnome-screenshot
 * - Windows: PowerShell screenshot
 *
 * Captures stored in ~/.orbit/captures/
 * Keeps last 50 captures, auto-cleans older ones.
 * ---------------------------------------------------------------------------
 */

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const CAPTURE_DIR      = path.join(os.homedir(), '.orbit', 'captures');
const CAPTURE_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MAX_CAPTURES     = 50;

function ensureDir() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
}

/**
 * Take a screenshot and return the file path (or null on failure)
 */
function capture() {
  ensureDir();
  const filename = `screen-${Date.now()}.png`;
  const filepath = path.join(CAPTURE_DIR, filename);

  try {
    if (process.platform === 'darwin') {
      // -x: no sound, -t png: format
      execSync(`screencapture -x -t png "${filepath}"`, { timeout: 5000 });
    } else if (process.platform === 'linux') {
      try {
        execSync(`scrot "${filepath}"`, { timeout: 5000 });
      } catch {
        execSync(`gnome-screenshot -f "${filepath}"`, { timeout: 5000 });
      }
    } else if (process.platform === 'win32') {
      const escaped = filepath.replace(/\\/g, '\\\\');
      execSync(
        `powershell -NoProfile -c "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('${escaped}') }"`,
        { timeout: 10000 }
      );
    } else {
      console.warn(`[screen-capture] 지원하지 않는 플랫폼: ${process.platform}`);
      return null;
    }

    // Verify file was created
    if (!fs.existsSync(filepath)) {
      console.warn('[screen-capture] 캡처 파일 미생성');
      return null;
    }

    console.log(`[screen-capture] 캡처 완료: ${filename}`);

    // Clean up old captures (keep last MAX_CAPTURES)
    try {
      const files = fs.readdirSync(CAPTURE_DIR)
        .filter(f => f.startsWith('screen-') && f.endsWith('.png'))
        .sort()
        .reverse();
      files.slice(MAX_CAPTURES).forEach(f => {
        try { fs.unlinkSync(path.join(CAPTURE_DIR, f)); } catch {}
      });
    } catch {}

    return filepath;
  } catch (e) {
    console.warn('[screen-capture] 캡처 실패:', e.message);
    return null;
  }
}

let _timer = null;

function start() {
  if (_timer) return;
  console.log(`[screen-capture] 시작 (${CAPTURE_INTERVAL / 1000}초 간격, 저장: ${CAPTURE_DIR})`);
  capture(); // immediate first capture
  _timer = setInterval(capture, CAPTURE_INTERVAL);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log('[screen-capture] 종료');
  }
}

/**
 * Get list of recent capture file paths
 * @param {number} count - number of recent captures to return
 * @returns {string[]}
 */
function getRecentCaptures(count = 10) {
  ensureDir();
  try {
    return fs.readdirSync(CAPTURE_DIR)
      .filter(f => f.startsWith('screen-') && f.endsWith('.png'))
      .sort()
      .reverse()
      .slice(0, count)
      .map(f => path.join(CAPTURE_DIR, f));
  } catch {
    return [];
  }
}

module.exports = { start, stop, capture, getRecentCaptures, CAPTURE_DIR };
