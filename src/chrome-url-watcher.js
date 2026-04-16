'use strict';

const os = require('os');
const { spawn } = require('child_process');

const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const URL_WINDOW_MS = 10 * 60 * 1000;   // 10 minutes
const MAX_SENT_CACHE = 30;

const BROWSER_APPS = ['chrome', 'msedge', 'edge', 'whale', 'firefox', 'brave'];

// Domains where only the bare hostname with no meaningful path are skipped
const SKIP_DOMAINS = [
  'google.com',
  'naver.com',
  'daum.net',
  'bing.com',
  'youtube.com',
  'gmail.com',
];

const SKIP_SCHEMES = ['chrome-extension://', 'about:', 'data:', 'javascript:'];

// Python script (inline) — reads Chrome/Edge History via temp-copy to bypass file lock
const PYTHON_SCRIPT = `
import sqlite3,shutil,os,time,json,sys,tempfile
browsers=[
  os.path.join(os.environ.get('LOCALAPPDATA',''),'Google','Chrome','User Data','Default','History'),
  os.path.join(os.environ.get('LOCALAPPDATA',''),'Microsoft','Edge','User Data','Default','History'),
]
results=[]
for src in browsers:
  if not os.path.exists(src): continue
  tmp=os.path.join(tempfile.gettempdir(),'orbit_bh_'+str(int(time.time()*1000))+'.db')
  try:
    shutil.copy2(src,tmp)
    conn=sqlite3.connect(tmp)
    c=conn.cursor()
    since_us=int((time.time()-600)*1e6+11644473600*1e6)
    c.execute("SELECT url,title,last_visit_time FROM urls WHERE last_visit_time>? ORDER BY last_visit_time DESC LIMIT 15",(since_us,))
    for r in c.fetchall():
      unix_ms=int((r[2]-11644473600*1e6)/1000)
      results.append({"url":r[0],"title":r[1],"ts":unix_ms})
    conn.close()
  except Exception as e:
    sys.stderr.write(json.dumps({"error":str(e)})+"\n")
  finally:
    try:os.remove(tmp)
    except:pass
seen=set()
for r in sorted(results,key=lambda x:-x["ts"]):
  if r["url"] not in seen:
    seen.add(r["url"])
    print(json.dumps(r))
`.trim();

// Module state
let _running = false;
let _timer = null;
let _recentlyActiveBrowser = false;
let _lastSentUrls = new Set();

let _onUrl = null;
let _reportEvent = null;
let _getActiveApp = null;

/**
 * Returns true if the URL should be filtered out.
 * Skips internal browser schemes, and bare homepages of trivial domains.
 */
function _shouldSkip(url) {
  if (!url || typeof url !== 'string') return true;

  // Skip internal schemes
  for (const scheme of SKIP_SCHEMES) {
    if (url.startsWith(scheme)) return true;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true; // unparseable
  }

  const hostname = parsed.hostname.replace(/^www\./, '');
  const path = parsed.pathname;

  // Skip if URL has no meaningful path (just '/' or empty) on trivial domains
  const isTrivialDomain = SKIP_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  if (isTrivialDomain) {
    const hasPath = path && path !== '/' && path.length > 1;
    const hasQuery = parsed.search && parsed.search.length > 1;
    if (!hasPath && !hasQuery) return true;
  }

  return false;
}

/**
 * Add a URL to the sent-cache, evicting oldest entries when over limit.
 */
function _trackSent(url) {
  _lastSentUrls.add(url);
  if (_lastSentUrls.size > MAX_SENT_CACHE) {
    // Remove the first (oldest) entry
    const first = _lastSentUrls.values().next().value;
    _lastSentUrls.delete(first);
  }
}

/**
 * Run Python to collect recent browser history, then fire callbacks.
 */
function _collect() {
  if (os.platform() !== 'win32') return;

  const now = Date.now();
  const windowStart = now - URL_WINDOW_MS;

  let child;
  try {
    child = spawn('python', ['-c', PYTHON_SCRIPT], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Python not available — silently skip
    return;
  }

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  child.on('error', () => {
    // spawn failed — silently skip
  });

  child.on('close', () => {
    const lines = stdout.split('\n').filter(l => l.trim());
    let sent = 0;

    for (const line of lines) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      const { url, title, ts } = rec;

      // Must be within the time window
      if (typeof ts !== 'number' || ts < windowStart || ts > now + 5000) continue;

      // Apply URL filters
      if (_shouldSkip(url)) continue;

      // Dedup
      if (_lastSentUrls.has(url)) continue;

      _trackSent(url);

      if (typeof _onUrl === 'function') {
        try {
          _onUrl(url, title || '', new Date(ts));
        } catch {
          // callback error — ignore
        }
      }

      if (typeof _reportEvent === 'function') {
        try {
          _reportEvent('browser.navigation', { url, title: title || '', visitedAt: ts });
        } catch {
          // ignore
        }
      }

      sent++;
    }

    if (sent > 0) {
      console.log(`[chrome-url] ${sent} url${sent === 1 ? '' : 's'} collected`);
    }
  });
}

/**
 * Scheduled poll: only collect if a browser was recently the active app.
 */
function _poll() {
  if (!_running) return;

  // Re-check active app in case getActiveApp is available
  if (typeof _getActiveApp === 'function') {
    try {
      const active = _getActiveApp();
      if (active && typeof active === 'string') {
        const lower = active.toLowerCase();
        if (BROWSER_APPS.some(b => lower.includes(b))) {
          _recentlyActiveBrowser = true;
        }
      }
    } catch {
      // ignore
    }
  }

  if (_recentlyActiveBrowser) {
    _collect();
  }

  _timer = setTimeout(_poll, POLL_INTERVAL_MS);
}

/**
 * Start the watcher.
 * @param {object} opts
 * @param {function} opts.onUrl        - fn(url, title, visitedAt: Date)
 * @param {function} [opts.reportEvent]- fn(type, data)
 * @param {function} [opts.getActiveApp] - fn() => string
 */
function start(opts = {}) {
  if (os.platform() !== 'win32') return;
  if (_running) return;

  _onUrl = opts.onUrl || null;
  _reportEvent = opts.reportEvent || null;
  _getActiveApp = opts.getActiveApp || null;
  _running = true;
  _recentlyActiveBrowser = false;
  _lastSentUrls = new Set();

  _timer = setTimeout(_poll, POLL_INTERVAL_MS);
}

/**
 * Stop the watcher.
 */
function stop() {
  _running = false;
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
}

/**
 * Called by the host agent when the active app changes.
 * Marks _recentlyActiveBrowser = true if a browser just became active.
 * @param {string} appName
 */
function onAppSwitch(appName) {
  if (!appName || typeof appName !== 'string') return;
  const lower = appName.toLowerCase();
  if (BROWSER_APPS.some(b => lower.includes(b))) {
    _recentlyActiveBrowser = true;
  }
}

module.exports = { start, stop, onAppSwitch };
