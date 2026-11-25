// orbit-collector-rs (Phase 1 hardened canary collector)
//
// Production-hardened Rust sidecar collector:
//   1. Native HTTPS/TLS via Windows WinHTTP FFI (zero external crates, Railway HTTPS ready)
//   2. Valid RFC3339/ISO8601 UTC timestamps (`YYYY-MM-DDTHH:MM:SS.sssZ`)
//   3. Honest spool relay & optional screen capture pipeline + bounded JSONL ring buffer
//      + built-in privacy gate (financial/security/personal/private-messenger blocking)
//      — ZERO synthetic keyboard/mouse stub events!
//   4. Zero-side-effect `--dry-run` and `--self-test` modes for safe 1-PC canary verification.

mod http_client;
mod iso_time;
mod privacy;
mod ring_buffer;
mod win_capture;

use crate::iso_time::{is_valid_rfc3339_utc, now_iso, now_ms};
use crate::ring_buffer::JsonlRingBuffer;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct Cfg {
    server: String,
    user: String,
    token: String,
    capture_enabled: bool,
    capture_ms: u64,
    spool_ms: u64,
    spool_batch: usize,
    heartbeat_ms: u64,
    retry_ms: u64,
    ring_max_events: usize,
    ring_max_bytes: usize,
    capdir: PathBuf,
    stats: PathBuf,
    duration_ms: u64,
    dry_run: bool,
    once: bool,
}

fn env_u64(k: &str, d: u64) -> u64 {
    std::env::var(k)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(d)
}

fn env_bool(k: &str, d: bool) -> bool {
    match std::env::var(k) {
        Ok(v) => matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        Err(_) => d,
    }
}

fn default_capdir() -> PathBuf {
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        PathBuf::from(home).join(".orbit").join("captures")
    } else {
        std::env::temp_dir().join("orbit-collector-rs")
    }
}

fn cfg(dry_run: bool, once: bool) -> Cfg {
    let capdir = std::env::var("COLL_CAPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_capdir());
    Cfg {
        server: std::env::var("COLL_SERVER")
            .or_else(|_| std::env::var("ORBIT_SERVER_URL"))
            .unwrap_or_else(|_| "http://127.0.0.1:8092".into()),
        user: std::env::var("COLL_USER")
            .or_else(|_| std::env::var("ORBIT_USER_ID"))
            .unwrap_or_else(|_| "canary".into()),
        token: std::env::var("COLL_TOKEN")
            .or_else(|_| std::env::var("ORBIT_TOKEN"))
            .unwrap_or_default(),
        capture_enabled: env_bool("COLL_CAPTURE_ENABLED", true),
        capture_ms: env_u64("COLL_CAPTURE_MS", 60_000),
        spool_ms: env_u64("COLL_SPOOL_MS", 90_000),
        spool_batch: env_u64("COLL_SPOOL_BATCH", 30) as usize,
        heartbeat_ms: env_u64("COLL_HEARTBEAT_MS", 60_000),
        retry_ms: env_u64("COLL_RETRY_MS", 60_000),
        ring_max_events: env_u64("COLL_RING_MAX_EVENTS", 1000) as usize,
        ring_max_bytes: env_u64("COLL_RING_MAX_BYTES", 4 * 1024 * 1024) as usize,
        stats: std::env::var("COLL_STATS")
            .map(PathBuf::from)
            .unwrap_or_else(|_| capdir.join("rust-collector-stats.json")),
        capdir,
        duration_ms: env_u64("COLL_DURATION_MS", 0),
        dry_run,
        once,
    }
}

// Telemetry counters (honest metrics only — no fake kb/mouse counters)
static CAP_MADE: AtomicU64 = AtomicU64::new(0);
static CAP_UP: AtomicU64 = AtomicU64::new(0);
static CAP_BUF: AtomicU64 = AtomicU64::new(0);
static PRIVACY_BLOCKED: AtomicU64 = AtomicU64::new(0);
static HB_UP: AtomicU64 = AtomicU64::new(0);
static SEND_FAIL: AtomicU64 = AtomicU64::new(0);
static RETRY_DRAINED: AtomicU64 = AtomicU64::new(0);
static DRY_RUN_SKIPPED: AtomicU64 = AtomicU64::new(0);

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("orbit-collector-rs {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    if args.iter().any(|a| a == "--self-test") {
        let probe_url = args
            .windows(2)
            .find(|w| w[0] == "--probe-health")
            .map(|w| w[1].as_str());
        let ok = run_self_test(probe_url);
        std::process::exit(if ok { 0 } else { 1 });
    }

    let dry_run = args.iter().any(|a| a == "--dry-run") || env_bool("COLL_DRY_RUN", false);
    let once = args.iter().any(|a| a == "--once");

    if args.iter().any(|a| a == "--supervise") {
        supervise(dry_run);
        return;
    }

    run_agent(dry_run, once);
}

fn run_self_test(probe_health_url: Option<&str>) -> bool {
    let ts = now_iso();
    let iso8601_ok = is_valid_rfc3339_utc(&ts);

    let fin_v = privacy::classify_without_io("chrome.exe", "KB국민은행 인터넷뱅킹 - 계좌이체");
    let sec_v = privacy::classify_without_io("TouchEnNxKey.exe", "보안 모듈");
    let priv_v = privacy::classify_without_io("KakaoTalk.exe", "가족 단톡방");
    let work_v = privacy::classify_without_io("nenova.exe", "화훼 관리 프로그램");
    let privacy_gate_ok = !fin_v.allow && !sec_v.allow && !priv_v.allow && work_v.allow;

    let tmp_dir = std::env::temp_dir().join(format!("orbit-collector-selftest-{}", now_ms()));
    let rb = JsonlRingBuffer::new(&tmp_dir, 3, 4096);
    let mut ring_ok = true;
    for i in 1..=5 {
        if rb.push(&format!(r#"{{"seq":{i},"ts":"{ts}"}}"#)).is_err() {
            ring_ok = false;
        }
    }
    if rb.pending_count() != 3 {
        ring_ok = false;
    }
    let drained = rb.drain_with(2, |_| true).unwrap_or(0);
    if drained != 2 || rb.pending_count() != 1 {
        ring_ok = false;
    }
    let _ = std::fs::remove_dir_all(&tmp_dir);

    let esc = escape_json("화훼 \"테스트\" \\ line\nend");
    let json_escape_ok = esc == r#"화훼 \"테스트\" \\ line\nend"#;

    let https_parse_ok = http_client::parse_url("https://mindmap-viewer-production-adb2.up.railway.app")
        .map(|u| u.https && u.port == 443)
        .unwrap_or(false);
    let tls_backend = http_client::tls_self_check();
    let tls_client_ready = https_parse_ok && tls_backend.is_ok();

    let (probe_ok, probe_status) = match probe_health_url {
        Some(url) => match http_client::get_url(url, "/health", Duration::from_secs(10)) {
            Ok(resp) => (resp.status == 200, resp.status as i32),
            Err(_) => (false, -1),
        },
        None => (true, 0),
    };

    let all_ok = iso8601_ok && privacy_gate_ok && ring_ok && json_escape_ok && tls_client_ready && probe_ok;
    println!(
        r#"{{"ok":{all_ok},"version":"{ver}","timestamp":"{ts}","iso8601_ok":{iso8601_ok},"privacy_gate_ok":{privacy_gate_ok},"ring_buffer_ok":{ring_ok},"json_escape_ok":{json_escape_ok},"tls_client_ready":{tls_client_ready},"tls_backend":"{backend}","probe_status":{probe_status},"synthetic_stubs":false}}"#,
        ver = env!("CARGO_PKG_VERSION"),
        backend = tls_backend.unwrap_or("unavailable"),
    );
    all_ok
}

fn supervise(dry_run: bool) {
    let exe = std::env::current_exe().expect("current_exe");
    println!("[supervisor] start — supervising child collector process");
    let mut restarts = 0u32;
    loop {
        let t0 = Instant::now();
        let mut cmd = std::process::Command::new(&exe);
        cmd.env("COLL_SUPERVISED", "1");
        if dry_run {
            cmd.arg("--dry-run");
        }
        let status = cmd.status();
        let secs = t0.elapsed().as_secs();
        match status {
            Ok(s) => println!(
                "[supervisor] child exited (code={:?}, {}s alive) — restart #{}",
                s.code(),
                secs,
                restarts + 1
            ),
            Err(e) => println!("[supervisor] child spawn failed: {e}"),
        }
        restarts += 1;
        if secs < 1 {
            std::thread::sleep(Duration::from_secs(5));
        } else {
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}

fn run_agent(dry_run: bool, once: bool) {
    let c = Arc::new(cfg(dry_run, once));
    let _ = std::fs::create_dir_all(&c.capdir);
    let _ = std::fs::create_dir_all(buffer_dir(&c));
    let ring = Arc::new(JsonlRingBuffer::new(
        &buffer_dir(&c),
        c.ring_max_events,
        c.ring_max_bytes,
    ));

    println!(
        "[collector-rs] v{} mode={} server={} capture={}({}ms) spool={}ms(batch {}) hb={}ms ring_cap={}/{}B capdir={}",
        env!("CARGO_PKG_VERSION"),
        if c.dry_run { "dry-run" } else { "live" },
        c.server,
        c.capture_enabled,
        c.capture_ms,
        c.spool_ms,
        c.spool_batch,
        c.heartbeat_ms,
        c.ring_max_events,
        c.ring_max_bytes,
        c.capdir.display()
    );

    if c.once {
        if c.capture_enabled && capture_screen(&c) {
            CAP_MADE.fetch_add(1, Ordering::Relaxed);
        }
        upload_spool_batch(&c);
        send_heartbeat(&c, &ring);
        drain_ring_buffer(&c, &ring);
        write_stats(&c, &ring);
        println!("[collector-rs] single pass complete");
        return;
    }

    let stop = Arc::new(AtomicBool::new(false));
    let mut handles = Vec::new();

    // 1. Optional screen capture thread (privacy-gated before capture)
    if c.capture_enabled {
        let c = c.clone();
        let stop = stop.clone();
        handles.push(std::thread::spawn(move || {
            loop_every(c.capture_ms, &stop, || {
                if capture_screen(&c) {
                    CAP_MADE.fetch_add(1, Ordering::Relaxed);
                }
            });
        }));
    }

    // 2. Honest spool relay thread (scans capdir, privacy-gates sidecar, uploads to /api/vision/spool)
    {
        let c = c.clone();
        let stop = stop.clone();
        handles.push(std::thread::spawn(move || {
            let initial_delay = c.capture_ms.min(45_000);
            sleep_interruptible(Duration::from_millis(initial_delay), &stop);
            loop_every(c.spool_ms, &stop, || {
                upload_spool_batch(&c);
            });
        }));
    }

    // 3. Heartbeat thread (valid RFC3339 timestamp; failures go to bounded ring buffer)
    {
        let c = c.clone();
        let stop = stop.clone();
        let ring = ring.clone();
        handles.push(std::thread::spawn(move || {
            loop_every(c.heartbeat_ms, &stop, || {
                send_heartbeat(&c, &ring);
            });
        }));
    }

    // 4. Bounded JSONL ring buffer drain thread
    {
        let c = c.clone();
        let stop = stop.clone();
        let ring = ring.clone();
        handles.push(std::thread::spawn(move || {
            loop_every(c.retry_ms, &stop, || {
                drain_ring_buffer(&c, &ring);
            });
        }));
    }

    // 5. Stats writer thread
    {
        let c = c.clone();
        let stop = stop.clone();
        let ring = ring.clone();
        handles.push(std::thread::spawn(move || {
            loop_every(5_000, &stop, || {
                write_stats(&c, &ring);
            });
        }));
    }

    let t0 = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(200));
        if c.duration_ms > 0 && t0.elapsed().as_millis() as u64 >= c.duration_ms {
            stop.store(true, Ordering::Relaxed);
            break;
        }
    }

    for h in handles {
        let _ = h.join();
    }
    write_stats(&c, &ring);
    println!("[collector-rs] shutdown complete");
}

fn sleep_interruptible(dur: Duration, stop: &AtomicBool) {
    let deadline = Instant::now() + dur;
    while !stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        std::thread::sleep((deadline - now).min(Duration::from_millis(200)));
    }
}

fn loop_every<F: FnMut()>(period_ms: u64, stop: &AtomicBool, mut f: F) {
    let period = Duration::from_millis(period_ms.max(100));
    let mut next = Instant::now() + period;
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let now = Instant::now();
        if now >= next {
            f();
            next = Instant::now() + period;
        }
        let sleep = next
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(200));
        std::thread::sleep(sleep);
    }
}

fn buffer_dir(c: &Cfg) -> PathBuf {
    c.capdir.join("buffer-rs")
}

fn capture_screen(c: &Cfg) -> bool {
    let fg = win_capture::detect_foreground_window();
    let verdict = privacy::classify(&fg.app, &fg.window_title);
    if !verdict.allow {
        PRIVACY_BLOCKED.fetch_add(1, Ordering::Relaxed);
        return false;
    }

    if c.dry_run {
        DRY_RUN_SKIPPED.fetch_add(1, Ordering::Relaxed);
        return false;
    }

    let ts = now_ms();
    let png = c.capdir.join(format!("screen-{ts}.png"));
    if !win_capture::capture_primary_screen_png(&png) {
        return false;
    }

    let side = png.with_extension("json");
    let meta = format!(
        r#"{{"app":"{}","windowTitle":"{}","trigger":"timer","capturedAt":"{}"}}"#,
        escape_json(&fg.app),
        escape_json(&fg.window_title),
        now_iso()
    );
    let _ = std::fs::write(side, meta);
    true
}

fn sent_marker(c: &Cfg) -> PathBuf {
    c.capdir.join(".spool-uploaded")
}

fn list_unsent_pngs(c: &Cfg) -> Vec<PathBuf> {
    let sent_set = std::fs::read_to_string(sent_marker(c)).unwrap_or_default();
    let mut v: Vec<PathBuf> = std::fs::read_dir(&c.capdir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.extension().map(|x| x == "png").unwrap_or(false)
                        && p.file_name()
                            .map(|f| !sent_set.contains(&*f.to_string_lossy()))
                            .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v.reverse(); // newest first (matches screen-capture.js)
    v
}

fn upload_spool_batch(c: &Cfg) {
    let files = list_unsent_pngs(c);
    if files.is_empty() {
        return;
    }
    let mut sent: Vec<String> = std::fs::read_to_string(sent_marker(c))
        .unwrap_or_default()
        .lines()
        .map(|s| s.to_string())
        .collect();
    let mut updated = 0usize;

    for f in files.into_iter().take(c.spool_batch) {
        let fname = match f.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        let side = f.with_extension("json");
        let (app, title) = read_side(&side);

        // Enforce built-in privacy gate before reading or transmitting image bytes
        let verdict = privacy::classify(&app, &title);
        if !verdict.allow {
            PRIVACY_BLOCKED.fetch_add(1, Ordering::Relaxed);
            if !c.dry_run {
                sent.push(fname);
                updated += 1;
            }
            continue;
        }

        let bytes = match std::fs::read(&f) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if bytes.len() > 5_000_000 {
            if !c.dry_run {
                sent.push(fname);
                updated += 1;
            }
            continue;
        }

        let cap_id = f
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let body = build_spool_body(&bytes, &app, &title, &hostname(), &c.user, &now_iso(), &cap_id);

        if c.dry_run {
            DRY_RUN_SKIPPED.fetch_add(1, Ordering::Relaxed);
            println!(
                "[collector-rs][dry-run] would spool {} ({} bytes, app={})",
                fname,
                bytes.len(),
                app
            );
            continue;
        }

        if post_spool(c, &body) {
            sent.push(fname);
            CAP_UP.fetch_add(1, Ordering::Relaxed);
            updated += 1;
        } else {
            CAP_BUF.fetch_add(1, Ordering::Relaxed);
        }
    }

    if updated > 0 && !c.dry_run {
        let keep: Vec<String> = sent.into_iter().rev().take(4000).collect();
        let keep: Vec<String> = keep.into_iter().rev().collect();
        let _ = std::fs::write(sent_marker(c), keep.join("\n"));
    }
}

fn build_spool_body(
    png_bytes: &[u8],
    app: &str,
    title: &str,
    host: &str,
    user: &str,
    ts_iso: &str,
    cap_id: &str,
) -> String {
    let b64 = b64_encode(png_bytes);
    format!(
        r#"{{"imageBase64":"{b64}","app":"{app}","windowTitle":"{title}","hostname":"{host}","userId":"{user}","ts":"{ts}","trigger":"timer","captureId":"{cap_id}"}}"#,
        app = escape_json(app),
        title = escape_json(title),
        host = escape_json(host),
        user = escape_json(user),
        ts = escape_json(ts_iso),
        cap_id = escape_json(cap_id),
    )
}

fn read_side(p: &Path) -> (String, String) {
    let s = std::fs::read_to_string(p).unwrap_or_default();
    let app = extract_json_str(&s, "app").unwrap_or_default();
    let title = extract_json_str(&s, "windowTitle").unwrap_or_default();
    (app, title)
}

fn extract_json_str(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":\"");
    let start = json.find(&needle)? + needle.len();
    let mut out = String::new();
    let mut chars = json[start..].chars();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => return Some(out),
            '\\' => {
                if let Some(esc) = chars.next() {
                    match esc {
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        other => out.push(other),
                    }
                }
            }
            other => out.push(other),
        }
    }
    None
}

fn hook_body(etype: &str, data_json: &str) -> String {
    let ts_iso = now_iso();
    let id_ms = now_ms();
    let host = hostname();
    format!(
        r#"{{"events":[{{"id":"{pre}-{id_ms}","type":"{etype}","source":"collector-rs","sessionId":"daemon-{host}","timestamp":"{ts_iso}","data":{data_json}}}]}}"#,
        pre = escape_json(etype.split('.').next().unwrap_or("ev")),
        etype = escape_json(etype),
        host = escape_json(&host),
    )
}

fn heartbeat_data(c: &Cfg, ring: &JsonlRingBuffer) -> String {
    format!(
        r#"{{"hostname":"{}","status":"ok","collector":"rust-sidecar","version":"{}","dryRun":{},"modules":{{"screen":{{"captures":{},"uploaded":{},"privacyBlocked":{}}},"ringBuffer":{{"pending":{},"bytes":{}}}}},"user":"{}"}}"#,
        escape_json(&hostname()),
        env!("CARGO_PKG_VERSION"),
        c.dry_run,
        CAP_MADE.load(Ordering::Relaxed),
        CAP_UP.load(Ordering::Relaxed),
        PRIVACY_BLOCKED.load(Ordering::Relaxed),
        ring.pending_count(),
        ring.file_bytes(),
        escape_json(&c.user),
    )
}

fn send_heartbeat(c: &Cfg, ring: &JsonlRingBuffer) {
    let body = hook_body("daemon.heartbeat", &heartbeat_data(c, ring));
    if c.dry_run {
        DRY_RUN_SKIPPED.fetch_add(1, Ordering::Relaxed);
        return;
    }
    if post_hook(c, &body) {
        HB_UP.fetch_add(1, Ordering::Relaxed);
    } else {
        let _ = ring.push(&body);
    }
}

fn drain_ring_buffer(c: &Cfg, ring: &JsonlRingBuffer) {
    if c.dry_run {
        return;
    }
    if let Ok(drained) = ring.drain_with(50, |body| post_hook(c, body)) {
        if drained > 0 {
            RETRY_DRAINED.fetch_add(drained as u64, Ordering::Relaxed);
        }
    }
}

fn post_hook(c: &Cfg, body: &str) -> bool {
    let tok = if c.token.is_empty() {
        None
    } else {
        Some(c.token.as_str())
    };
    match http_client::post_json(
        &c.server,
        "/api/hook",
        body,
        tok,
        &hostname(),
        Duration::from_secs(15),
    ) {
        Ok(resp) if (200..300).contains(&resp.status) => true,
        _ => {
            SEND_FAIL.fetch_add(1, Ordering::Relaxed);
            false
        }
    }
}

fn post_spool(c: &Cfg, body: &str) -> bool {
    let tok = if c.token.is_empty() {
        None
    } else {
        Some(c.token.as_str())
    };
    match http_client::post_json(
        &c.server,
        "/api/vision/spool",
        body,
        tok,
        &hostname(),
        Duration::from_secs(30),
    ) {
        Ok(resp) if (200..300).contains(&resp.status) => true,
        _ => {
            SEND_FAIL.fetch_add(1, Ordering::Relaxed);
            false
        }
    }
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into())
}

fn write_stats(c: &Cfg, ring: &JsonlRingBuffer) {
    let s = format!(
        r#"{{"ts":"{}","version":"{}","dryRun":{},"capMade":{},"capUploaded":{},"capBuffered":{},"privacyBlocked":{},"hbUp":{},"sendFail":{},"retryDrained":{},"dryRunSkipped":{},"bufPending":{},"bufBytes":{}}}"#,
        now_iso(),
        env!("CARGO_PKG_VERSION"),
        c.dry_run,
        CAP_MADE.load(Ordering::Relaxed),
        CAP_UP.load(Ordering::Relaxed),
        CAP_BUF.load(Ordering::Relaxed),
        PRIVACY_BLOCKED.load(Ordering::Relaxed),
        HB_UP.load(Ordering::Relaxed),
        SEND_FAIL.load(Ordering::Relaxed),
        RETRY_DRAINED.load(Ordering::Relaxed),
        DRY_RUN_SKIPPED.load(Ordering::Relaxed),
        ring.pending_count(),
        ring.file_bytes(),
    );
    let _ = std::fs::write(&c.stats, s);
}

pub fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_body_uses_rfc3339_timestamp_and_honest_source() {
        let body = hook_body("daemon.heartbeat", r#"{"ok":true}"#);
        assert!(body.contains(r#""source":"collector-rs""#));
        assert!(body.contains(r#""type":"daemon.heartbeat""#));
        let ts = extract_json_str(&body, "timestamp").expect("timestamp field");
        assert!(
            is_valid_rfc3339_utc(&ts),
            "hook timestamp must be RFC3339 UTC, got: {ts}"
        );
    }

    #[test]
    fn spool_body_escapes_korean_and_quotes() {
        let body = build_spool_body(
            b"PNGDATA",
            "nenova",
            r#"화훼 "발주" \ 테스트"#,
            "PC-01",
            "user1",
            "2026-11-25T01:40:50.123Z",
            "screen-1",
        );
        assert!(body.contains(r#""ts":"2026-11-25T01:40:50.123Z""#));
        assert!(body.contains(r#""imageBase64":"UE5HREFUQQ==""#));
        assert_eq!(
            extract_json_str(&body, "windowTitle").as_deref(),
            Some(r#"화훼 "발주" \ 테스트"#)
        );
    }

    #[test]
    fn self_test_passes_without_side_effects() {
        assert!(run_self_test(None));
    }

    #[test]
    fn dry_run_spool_blocks_banking_and_never_writes_sent_marker() {
        let dir = std::env::temp_dir().join(format!("orbit-dryrun-spool-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let bank_png = dir.join("screen-100.png");
        std::fs::write(&bank_png, b"fake-png-bank").unwrap();
        std::fs::write(
            bank_png.with_extension("json"),
            r#"{"app":"chrome","windowTitle":"KB국민은행 인터넷뱅킹"}"#,
        )
        .unwrap();
        let work_png = dir.join("screen-200.png");
        std::fs::write(&work_png, b"fake-png-work").unwrap();
        std::fs::write(
            work_png.with_extension("json"),
            r#"{"app":"nenova","windowTitle":"화훼 관리 프로그램"}"#,
        )
        .unwrap();

        let c = Cfg {
            server: "http://127.0.0.1:9".into(),
            user: "canary".into(),
            token: "tok".into(),
            capture_enabled: false,
            capture_ms: 60_000,
            spool_ms: 90_000,
            spool_batch: 10,
            heartbeat_ms: 60_000,
            retry_ms: 60_000,
            ring_max_events: 100,
            ring_max_bytes: 65_536,
            stats: dir.join("stats.json"),
            capdir: dir.clone(),
            duration_ms: 0,
            dry_run: true,
            once: true,
        };
        let before_blocked = PRIVACY_BLOCKED.load(Ordering::Relaxed);
        let before_dry = DRY_RUN_SKIPPED.load(Ordering::Relaxed);
        upload_spool_batch(&c);
        assert!(PRIVACY_BLOCKED.load(Ordering::Relaxed) >= before_blocked + 1);
        assert!(DRY_RUN_SKIPPED.load(Ordering::Relaxed) >= before_dry + 1);
        assert!(!sent_marker(&c).exists(), "dry-run must not write .spool-uploaded");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
