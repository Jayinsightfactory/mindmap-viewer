use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Bounded JSONL ring buffer stored at `<dir>/events.jsonl`.
/// Guarantees strict upper bounds on both event count and disk bytes by evicting oldest lines.
#[derive(Debug, Clone)]
pub struct JsonlRingBuffer {
    path: PathBuf,
    max_events: usize,
    max_bytes: usize,
}

#[derive(Debug, Clone, Copy, Default)]
#[allow(dead_code)]
pub struct PushResult {
    pub evicted: usize,
    pub total_events: usize,
    pub total_bytes: usize,
}

impl JsonlRingBuffer {
    pub fn new(dir: &Path, max_events: usize, max_bytes: usize) -> Self {
        Self {
            path: dir.join("events.jsonl"),
            max_events: max_events.max(1),
            max_bytes: max_bytes.max(1024),
        }
    }

    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append a single JSON line (newlines sanitized to spaces) and compact if bounds exceeded.
    pub fn push(&self, json_line: &str) -> std::io::Result<PushResult> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let sanitized = json_line.replace(['\r', '\n'], " ");
        {
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?;
            file.write_all(sanitized.as_bytes())?;
            file.write_all(b"\n")?;
        }
        self.compact_if_needed()
    }

    pub fn pending_count(&self) -> usize {
        self.read_lines().len()
    }

    pub fn file_bytes(&self) -> usize {
        fs::metadata(&self.path).map(|m| m.len() as usize).unwrap_or(0)
    }

    /// Drain up to `limit` oldest lines in FIFO order using `send_fn`.
    /// Stops on first send failure and preserves remaining unsent lines atomically.
    pub fn drain_with<F>(&self, limit: usize, mut send_fn: F) -> std::io::Result<usize>
    where
        F: FnMut(&str) -> bool,
    {
        let lines = self.read_lines();
        if lines.is_empty() || limit == 0 {
            return Ok(0);
        }
        let mut drained = 0usize;
        for line in lines.iter().take(limit) {
            if send_fn(line) {
                drained += 1;
            } else {
                break;
            }
        }
        if drained > 0 {
            let remaining = &lines[drained..];
            self.rewrite_atomic(remaining)?;
        }
        Ok(drained)
    }

    fn read_lines(&self) -> Vec<String> {
        match fs::read_to_string(&self.path) {
            Ok(s) => s
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .map(|l| l.to_string())
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    fn compact_if_needed(&self) -> std::io::Result<PushResult> {
        let mut lines = self.read_lines();
        let initial_len = lines.len();
        let mut total_bytes: usize = lines.iter().map(|l| l.len() + 1).sum();

        let mut drop_n = 0usize;
        if lines.len() > self.max_events {
            drop_n = lines.len() - self.max_events;
        }
        while drop_n < lines.len().saturating_sub(1) {
            let rem_bytes: usize = lines[drop_n..].iter().map(|l| l.len() + 1).sum();
            if rem_bytes <= self.max_bytes {
                total_bytes = rem_bytes;
                break;
            }
            drop_n += 1;
        }
        if drop_n > 0 {
            lines.drain(0..drop_n);
            total_bytes = lines.iter().map(|l| l.len() + 1).sum();
            self.rewrite_atomic(&lines)?;
        }

        Ok(PushResult {
            evicted: initial_len - lines.len(),
            total_events: lines.len(),
            total_bytes,
        })
    }

    fn rewrite_atomic(&self, lines: &[String]) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("jsonl.tmp");
        {
            let mut f = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&tmp)?;
            for line in lines {
                f.write_all(line.as_bytes())?;
                f.write_all(b"\n")?;
            }
            f.flush()?;
        }
        if self.path.exists() {
            let _ = fs::remove_file(&self.path);
        }
        fs::rename(&tmp, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_dir(tag: &str) -> PathBuf {
        let ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("orbit-ring-{tag}-{ns}"))
    }

    #[test]
    fn enforces_max_events_and_drains_fifo() {
        let dir = tmp_dir("fifo");
        let rb = JsonlRingBuffer::new(&dir, 3, 64 * 1024);

        for i in 1..=5 {
            rb.push(&format!(r#"{{"id":{i}}}"#)).unwrap();
        }
        assert_eq!(rb.pending_count(), 3);

        let mut seen = Vec::new();
        let drained = rb
            .drain_with(2, |line| {
                seen.push(line.to_string());
                true
            })
            .unwrap();
        assert_eq!(drained, 2);
        assert_eq!(seen, vec![r#"{"id":3}"#, r#"{"id":4}"#]);
        assert_eq!(rb.pending_count(), 1);

        // Failing send preserves remaining item
        let failed = rb.drain_with(10, |_| false).unwrap();
        assert_eq!(failed, 0);
        assert_eq!(rb.pending_count(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn enforces_max_bytes_cap() {
        let dir = tmp_dir("bytes");
        let rb = JsonlRingBuffer::new(&dir, 100, 1024);
        let payload = format!(r#"{{"pad":"{}"}}"#, "x".repeat(300));
        for _ in 0..10 {
            rb.push(&payload).unwrap();
        }
        assert!(rb.file_bytes() <= 1024, "bytes exceeded: {}", rb.file_bytes());
        assert!(rb.pending_count() >= 1 && rb.pending_count() <= 3);
        let _ = fs::remove_dir_all(&dir);
    }
}
