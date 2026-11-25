use crate::iso_time::{now_ms, parse_iso_utc_ms};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivacyVerdict {
    pub allow: bool,
    pub kind: &'static str,
    pub reason: &'static str,
}

/// Banking / Korean financial security process prefixes (aligned with daemon/personal-agent.js).
const SECURITY_PROC_PREFIXES: &[&str] = &[
    "touchen",
    "nprotect",
    "npkcrypt",
    "npupdate",
    "npagent",
    "astx",
    "keysharp",
    "kdefense",
    "asdsvc",
    "v3ltray",
    "v3lite",
    "inisafe",
    "crossweb",
    "delfino",
    "magicline",
    "veraport",
    "unisign",
    "xecure",
    "clientkeeper",
    "ipinside",
    "1password",
    "bitwarden",
    "keepass",
    "lastpass",
];

/// Financial, banking, security, authentication, and credential window title keywords.
const FINANCIAL_SECURITY_TITLE_KEYWORDS: &[&str] = &[
    "인터넷뱅킹",
    "기업뱅킹",
    "스마트뱅킹",
    "뱅킹",
    "공동인증서",
    "금융인증서",
    "공인인증",
    "보안카드",
    "계좌이체",
    "카드결제",
    "비밀번호",
    "암호 입력",
    "가상키보드",
    "키보드보안",
    "kb국민",
    "국민은행",
    "신한은행",
    "우리은행",
    "하나은행",
    "농협은행",
    "기업은행",
    "카카오뱅크",
    "토스뱅크",
    "케이뱅크",
    "증권",
    "홈트레이딩",
    "password",
    "passkey",
    "1password",
    "bitwarden",
    "keepass",
    "keychain",
    "authenticator",
    "otp",
    "online banking",
    "internet banking",
    "touchen",
    "nprotect",
    "inisafe",
    "ahnlab safe",
    "veraport",
    "delfino",
];

/// Personal/private window patterns (aligned with src/privacy-gate.js DEFAULT_POLICY).
const PERSONAL_TITLE_KEYWORDS: &[&str] = &[
    "[개인]",
    "google 검색",
    "- google search",
    "- naver",
    "네이버 쇼핑",
    "naver 쇼핑",
    "youtube",
    "쿠팡",
    "coupang",
    "11번가",
    "g마켓",
    "gmarket",
    "옥션",
    "당근",
    "인스타그램",
    "instagram",
    "facebook",
    "넷플릭스",
    "netflix",
    "웹툰",
    "나무위키",
    "- daum 검색",
];

const MESSENGER_APPS: &[&str] = &[
    "kakaotalk",
    "카카오톡",
    "wechat",
    "weixin",
    "微信",
    "line",
    "telegram",
    "whatsapp",
    "whatsapp.root",
    "discord",
    "nateon",
    "네이트온",
    "slack",
];

const WORK_ROOMS: &[&str] = &[
    "수입방",
    "현장방",
    "영업방",
    "현장 추가취소방",
    "수입불량방",
    "빌번호방",
    "네노바&선율방",
    "견적방",
    "스케줄방",
];

fn normalize_app(app: &str) -> String {
    let trimmed = app.trim().to_lowercase();
    let base = trimmed
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(&trimmed);
    base.strip_suffix(".exe").unwrap_or(base).to_string()
}

/// Normalize chat room name to match src/privacy-gate.js normalizeRoomName().
pub fn normalize_room_name(raw: &str) -> String {
    let mut t: String = raw
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    for _ in 0..4 {
        let before = t.clone();
        for suffix in [" - 카카오톡", "- 카카오톡", " - kakaotalk", "- kakaotalk"] {
            if let Some(s) = t.strip_suffix(suffix) {
                t = s.trim().to_string();
            }
        }
        for suffix in ["님의 메시지", "'s message"] {
            if let Some(s) = t.strip_suffix(suffix) {
                t = s.trim().to_string();
            }
        }
        // Strip trailing parenthesized member count like "(12)"
        if t.ends_with(')') {
            if let Some(open) = t.rfind('(') {
                let inside = &t[open + 1..t.len() - 1];
                if !inside.is_empty() && inside.len() <= 4 && inside.chars().all(|c| c.is_ascii_digit()) {
                    t = t[..open].trim().to_string();
                }
            }
        }
        // Strip decorative stars/bullets at ends
        t = t
            .trim_matches(|c: char| matches!(c, '●' | '★' | '☆' | '*' | ' '))
            .to_string();
        if t == before {
            break;
        }
    }
    t
}

/// Check `~/.orbit/personal-pause-until` (or custom path) to see if user paused collection.
pub fn is_paused_file(pause_path: &Path, now_epoch_ms: u64) -> bool {
    let content = match std::fs::read_to_string(pause_path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    match parse_iso_utc_ms(&content) {
        Some(until_ms) => now_epoch_ms < until_ms,
        None => false,
    }
}

pub fn default_pause_file() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(std::path::PathBuf::from(home).join(".orbit").join("personal-pause-until"))
}

pub fn classify(app: &str, window_title: &str) -> PrivacyVerdict {
    if let Some(pause_path) = default_pause_file() {
        if is_paused_file(&pause_path, now_ms()) {
            return PrivacyVerdict {
                allow: false,
                kind: "paused",
                reason: "personal_pause",
            };
        }
    }
    classify_without_io(app, window_title)
}

pub fn classify_without_io(app: &str, window_title: &str) -> PrivacyVerdict {
    let app_norm = normalize_app(app);
    let title_trimmed = window_title.trim();
    let title_low = title_trimmed.to_lowercase();

    // 1) Financial / banking / security processes (highest priority)
    if !app_norm.is_empty()
        && SECURITY_PROC_PREFIXES
            .iter()
            .any(|p| app_norm.starts_with(p) || app_norm == *p)
    {
        return PrivacyVerdict {
            allow: false,
            kind: "security_financial",
            reason: "security_process",
        };
    }

    // 2) Financial / banking / credential / security windows
    if !title_low.is_empty()
        && FINANCIAL_SECURITY_TITLE_KEYWORDS
            .iter()
            .any(|kw| title_low.contains(kw))
    {
        return PrivacyVerdict {
            allow: false,
            kind: "security_financial",
            reason: "financial_or_security_window",
        };
    }

    // 3) Messenger gate: allow ONLY exact normalized work rooms
    let is_messenger = (!app_norm.is_empty() && MESSENGER_APPS.iter().any(|m| app_norm == *m))
        || (!title_low.is_empty() && MESSENGER_APPS.iter().any(|m| title_low == *m));
    if is_messenger {
        let norm_room = normalize_room_name(title_trimmed);
        if !norm_room.is_empty() && WORK_ROOMS.iter().any(|r| *r == norm_room) {
            return PrivacyVerdict {
                allow: true,
                kind: "messenger_work",
                reason: "work_room",
            };
        }
        return PrivacyVerdict {
            allow: false,
            kind: "messenger_private",
            reason: if title_trimmed.is_empty() {
                "messenger_no_title"
            } else {
                "not_work_room"
            },
        };
    }

    // 4) Personal web/app titles
    if !title_low.is_empty()
        && PERSONAL_TITLE_KEYWORDS
            .iter()
            .any(|kw| title_low.contains(kw))
    {
        return PrivacyVerdict {
            allow: false,
            kind: "personal_web",
            reason: "personal_title",
        };
    }

    PrivacyVerdict {
        allow: true,
        kind: "work",
        reason: "default_work",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_financial_and_security_windows_and_processes() {
        let v1 = classify_without_io("chrome.exe", "KB국민은행 인터넷뱅킹 - 계좌이체");
        assert!(!v1.allow);
        assert_eq!(v1.kind, "security_financial");

        let v2 = classify_without_io("TouchEnNxKey.exe", "보안 모듈");
        assert!(!v2.allow);
        assert_eq!(v2.reason, "security_process");

        let v3 = classify_without_io("msedge.exe", "공동인증서 비밀번호 입력");
        assert!(!v3.allow);
        assert_eq!(v3.kind, "security_financial");

        let v4 = classify_without_io("1Password.exe", "Vault");
        assert!(!v4.allow);
        assert_eq!(v4.kind, "security_financial");
    }

    #[test]
    fn blocks_personal_and_private_messenger_but_allows_work() {
        let work = classify_without_io("nenova.exe", "화훼 관리 프로그램 - 주문관리");
        assert!(work.allow);
        assert_eq!(work.kind, "work");

        let work_room = classify_without_io("KakaoTalk.exe", "수입방 (12) - 카카오톡");
        assert!(work_room.allow);
        assert_eq!(work_room.kind, "messenger_work");

        let priv_room = classify_without_io("KakaoTalk.exe", "가족 단톡방");
        assert!(!priv_room.allow);
        assert_eq!(priv_room.kind, "messenger_private");

        let yt = classify_without_io("chrome.exe", "YouTube - Music");
        assert!(!yt.allow);
        assert_eq!(yt.kind, "personal_web");
    }
}
