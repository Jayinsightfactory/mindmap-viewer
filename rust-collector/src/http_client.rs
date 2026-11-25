use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedUrl {
    pub https: bool,
    pub host: String,
    pub port: u16,
    pub base_path: String,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    #[allow(dead_code)]
    pub body: String,
}

pub fn parse_url(raw: &str) -> Result<ParsedUrl, String> {
    let trimmed = raw.trim();
    let (https, rest) = if let Some(r) = trimmed.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = trimmed.strip_prefix("http://") {
        (false, r)
    } else {
        return Err(format!("unsupported URL scheme: {trimmed}"));
    };

    let (authority, path_part) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, ""),
    };
    if authority.is_empty() {
        return Err(format!("missing host in URL: {trimmed}"));
    }

    let default_port = if https { 443 } else { 80 };
    let (host, port) = if let Some((h, p)) = authority.rsplit_once(':') {
        let parsed_port = p
            .parse::<u16>()
            .map_err(|_| format!("invalid port in URL: {trimmed}"))?;
        (h.to_string(), parsed_port)
    } else {
        (authority.to_string(), default_port)
    };

    if host.is_empty() {
        return Err(format!("empty host in URL: {trimmed}"));
    }

    Ok(ParsedUrl {
        https,
        host,
        port,
        base_path: path_part.trim_end_matches('/').to_string(),
    })
}

pub fn join_path(base_path: &str, path: &str) -> String {
    let clean_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    if base_path.is_empty() {
        clean_path
    } else {
        format!("{base_path}{clean_path}")
    }
}

pub fn post_json(
    server_url: &str,
    path: &str,
    body: &str,
    bearer_token: Option<&str>,
    device_id: &str,
    timeout: Duration,
) -> Result<HttpResponse, String> {
    let parsed = parse_url(server_url)?;
    let full_path = join_path(&parsed.base_path, path);
    #[cfg(windows)]
    {
        winhttp_impl::request(
            &parsed,
            "POST",
            &full_path,
            Some(body.as_bytes()),
            bearer_token,
            Some(device_id),
            timeout,
        )
    }
    #[cfg(not(windows))]
    {
        fallback_http::request(&parsed, "POST", &full_path, Some(body), bearer_token, Some(device_id), timeout)
    }
}

pub fn get_url(server_url: &str, path: &str, timeout: Duration) -> Result<HttpResponse, String> {
    let parsed = parse_url(server_url)?;
    let full_path = join_path(&parsed.base_path, path);
    #[cfg(windows)]
    {
        winhttp_impl::request(&parsed, "GET", &full_path, None, None, None, timeout)
    }
    #[cfg(not(windows))]
    {
        fallback_http::request(&parsed, "GET", &full_path, None, None, None, timeout)
    }
}

/// Verify TLS client library readiness without making an external network request.
pub fn tls_self_check() -> Result<&'static str, String> {
    #[cfg(windows)]
    {
        winhttp_impl::self_check()
    }
    #[cfg(not(windows))]
    {
        Err("WinHTTP TLS backend is Windows-only".to_string())
    }
}

#[cfg(windows)]
mod winhttp_impl {
    use super::{HttpResponse, ParsedUrl};
    use std::ffi::c_void;
    use std::ptr;
    use std::time::Duration;

    type HModule = *mut c_void;
    type HInternet = *mut c_void;
    type FarProc = *const c_void;

    const WINHTTP_ACCESS_TYPE_DEFAULT_PROXY: u32 = 0;
    const WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY: u32 = 4;
    const WINHTTP_FLAG_SECURE: u32 = 0x0080_0000;
    const WINHTTP_QUERY_STATUS_CODE: u32 = 19;
    const WINHTTP_QUERY_FLAG_NUMBER: u32 = 0x2000_0000;

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryW(lpLibFileName: *const u16) -> HModule;
        fn GetProcAddress(hModule: HModule, lpProcName: *const u8) -> FarProc;
        fn GetLastError() -> u32;
    }

    type FnWinHttpOpen = unsafe extern "system" fn(*const u16, u32, *const u16, *const u16, u32) -> HInternet;
    type FnWinHttpSetTimeouts = unsafe extern "system" fn(HInternet, i32, i32, i32, i32) -> i32;
    type FnWinHttpConnect = unsafe extern "system" fn(HInternet, *const u16, u16, u32) -> HInternet;
    type FnWinHttpOpenRequest = unsafe extern "system" fn(
        HInternet,
        *const u16,
        *const u16,
        *const u16,
        *const u16,
        *const *const u16,
        u32,
    ) -> HInternet;
    type FnWinHttpSendRequest =
        unsafe extern "system" fn(HInternet, *const u16, u32, *mut c_void, u32, u32, usize) -> i32;
    type FnWinHttpReceiveResponse = unsafe extern "system" fn(HInternet, *mut c_void) -> i32;
    type FnWinHttpQueryHeaders =
        unsafe extern "system" fn(HInternet, u32, *const u16, *mut c_void, *mut u32, *mut u32) -> i32;
    type FnWinHttpReadData =
        unsafe extern "system" fn(HInternet, *mut c_void, u32, *mut u32) -> i32;
    type FnWinHttpCloseHandle = unsafe extern "system" fn(HInternet) -> i32;

    struct WinHttpApi {
        open: FnWinHttpOpen,
        set_timeouts: FnWinHttpSetTimeouts,
        connect: FnWinHttpConnect,
        open_request: FnWinHttpOpenRequest,
        send_request: FnWinHttpSendRequest,
        receive_response: FnWinHttpReceiveResponse,
        query_headers: FnWinHttpQueryHeaders,
        read_data: FnWinHttpReadData,
        close_handle: FnWinHttpCloseHandle,
    }

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn load_api() -> Result<WinHttpApi, String> {
        let dll = to_wide("winhttp.dll");
        let hmod = unsafe { LoadLibraryW(dll.as_ptr()) };
        if hmod.is_null() {
            return Err(format!("LoadLibraryW(winhttp.dll) failed: {}", unsafe { GetLastError() }));
        }
        macro_rules! load_sym {
            ($name:literal, $ty:ty) => {{
                let p = unsafe { GetProcAddress(hmod, concat!($name, "\0").as_ptr()) };
                if p.is_null() {
                    return Err(format!("GetProcAddress({}) failed", $name));
                }
                unsafe { std::mem::transmute::<FarProc, $ty>(p) }
            }};
        }
        Ok(WinHttpApi {
            open: load_sym!("WinHttpOpen", FnWinHttpOpen),
            set_timeouts: load_sym!("WinHttpSetTimeouts", FnWinHttpSetTimeouts),
            connect: load_sym!("WinHttpConnect", FnWinHttpConnect),
            open_request: load_sym!("WinHttpOpenRequest", FnWinHttpOpenRequest),
            send_request: load_sym!("WinHttpSendRequest", FnWinHttpSendRequest),
            receive_response: load_sym!("WinHttpReceiveResponse", FnWinHttpReceiveResponse),
            query_headers: load_sym!("WinHttpQueryHeaders", FnWinHttpQueryHeaders),
            read_data: load_sym!("WinHttpReadData", FnWinHttpReadData),
            close_handle: load_sym!("WinHttpCloseHandle", FnWinHttpCloseHandle),
        })
    }

    struct HandleGuard {
        h: HInternet,
        close_fn: FnWinHttpCloseHandle,
    }
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            if !self.h.is_null() {
                unsafe { (self.close_fn)(self.h) };
            }
        }
    }

    pub fn self_check() -> Result<&'static str, String> {
        let api = load_api()?;
        let ua = to_wide("orbit-collector-rs/0.2");
        let mut session = unsafe {
            (api.open)(
                ua.as_ptr(),
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                ptr::null(),
                ptr::null(),
                0,
            )
        };
        if session.is_null() {
            session = unsafe {
                (api.open)(
                    ua.as_ptr(),
                    WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                    ptr::null(),
                    ptr::null(),
                    0,
                )
            };
        }
        if session.is_null() {
            return Err(format!("WinHttpOpen failed: {}", unsafe { GetLastError() }));
        }
        unsafe { (api.close_handle)(session) };
        Ok("winhttp-native-tls")
    }

    pub fn request(
        parsed: &ParsedUrl,
        method: &str,
        full_path: &str,
        body: Option<&[u8]>,
        bearer_token: Option<&str>,
        device_id: Option<&str>,
        timeout: Duration,
    ) -> Result<HttpResponse, String> {
        let api = load_api()?;
        let ua = to_wide("orbit-collector-rs/0.2");
        let mut session = unsafe {
            (api.open)(
                ua.as_ptr(),
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                ptr::null(),
                ptr::null(),
                0,
            )
        };
        if session.is_null() {
            session = unsafe {
                (api.open)(
                    ua.as_ptr(),
                    WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                    ptr::null(),
                    ptr::null(),
                    0,
                )
            };
        }
        if session.is_null() {
            return Err(format!("WinHttpOpen failed: {}", unsafe { GetLastError() }));
        }
        let _session_guard = HandleGuard { h: session, close_fn: api.close_handle };

        let t_ms = timeout.as_millis().min(i32::MAX as u128) as i32;
        unsafe { (api.set_timeouts)(session, t_ms, t_ms, t_ms, t_ms) };

        let host_w = to_wide(&parsed.host);
        let connect = unsafe { (api.connect)(session, host_w.as_ptr(), parsed.port, 0) };
        if connect.is_null() {
            return Err(format!("WinHttpConnect failed: {}", unsafe { GetLastError() }));
        }
        let _connect_guard = HandleGuard { h: connect, close_fn: api.close_handle };

        let method_w = to_wide(method);
        let path_w = to_wide(full_path);
        let flags = if parsed.https { WINHTTP_FLAG_SECURE } else { 0 };
        let req = unsafe {
            (api.open_request)(
                connect,
                method_w.as_ptr(),
                path_w.as_ptr(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                flags,
            )
        };
        if req.is_null() {
            return Err(format!("WinHttpOpenRequest failed: {}", unsafe { GetLastError() }));
        }
        let _req_guard = HandleGuard { h: req, close_fn: api.close_handle };

        let mut hdrs = String::new();
        if body.is_some() {
            hdrs.push_str("Content-Type: application/json\r\n");
        }
        if let Some(dev) = device_id {
            if !dev.is_empty() {
                hdrs.push_str(&format!("X-Device-Id: {dev}\r\n"));
            }
        }
        if let Some(tok) = bearer_token {
            if !tok.is_empty() {
                hdrs.push_str(&format!("Authorization: Bearer {tok}\r\n"));
            }
        }

        let hdrs_w = to_wide(&hdrs);
        let (hdr_ptr, hdr_len) = if hdrs.is_empty() {
            (ptr::null(), 0u32)
        } else {
            // Exclude trailing NUL from length
            (hdrs_w.as_ptr(), (hdrs_w.len() - 1) as u32)
        };

        let (body_ptr, body_len) = match body {
            Some(b) if !b.is_empty() => (b.as_ptr() as *mut c_void, b.len() as u32),
            _ => (ptr::null_mut(), 0u32),
        };

        let sent = unsafe {
            (api.send_request)(req, hdr_ptr, hdr_len, body_ptr, body_len, body_len, 0)
        };
        if sent == 0 {
            return Err(format!("WinHttpSendRequest failed: {}", unsafe { GetLastError() }));
        }

        let recvd = unsafe { (api.receive_response)(req, ptr::null_mut()) };
        if recvd == 0 {
            return Err(format!("WinHttpReceiveResponse failed: {}", unsafe { GetLastError() }));
        }

        let mut status_code: u32 = 0;
        let mut status_size: u32 = std::mem::size_of::<u32>() as u32;
        let ok_q = unsafe {
            (api.query_headers)(
                req,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                ptr::null(),
                &mut status_code as *mut u32 as *mut c_void,
                &mut status_size,
                ptr::null_mut(),
            )
        };
        if ok_q == 0 {
            return Err(format!("WinHttpQueryHeaders failed: {}", unsafe { GetLastError() }));
        }

        // Read bounded response body (up to 64KB)
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let mut n_read: u32 = 0;
            let ok_r = unsafe {
                (api.read_data)(req, buf.as_mut_ptr() as *mut c_void, buf.len() as u32, &mut n_read)
            };
            if ok_r == 0 || n_read == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n_read as usize]);
            if out.len() >= 65_536 {
                break;
            }
        }

        Ok(HttpResponse {
            status: status_code as u16,
            body: String::from_utf8_lossy(&out).to_string(),
        })
    }
}

#[cfg(not(windows))]
mod fallback_http {
    use super::{HttpResponse, ParsedUrl};
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    pub fn request(
        parsed: &ParsedUrl,
        method: &str,
        full_path: &str,
        body: Option<&str>,
        bearer_token: Option<&str>,
        device_id: Option<&str>,
        timeout: Duration,
    ) -> Result<HttpResponse, String> {
        if parsed.https {
            return Err("HTTPS requires Windows WinHTTP backend".to_string());
        }
        let addr = format!("{}:{}", parsed.host, parsed.port)
            .to_socket_addrs()
            .map_err(|e| e.to_string())?
            .next()
            .ok_or_else(|| "DNS resolve returned no address".to_string())?;
        let mut s = TcpStream::connect_timeout(&addr, timeout).map_err(|e| e.to_string())?;
        let _ = s.set_read_timeout(Some(timeout));
        let _ = s.set_write_timeout(Some(timeout));
        let body_bytes = body.map(|b| b.as_bytes()).unwrap_or(&[]);
        let mut req = format!(
            "{method} {full_path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n",
            parsed.host
        );
        if body.is_some() {
            req.push_str("Content-Type: application/json\r\n");
            req.push_str(&format!("Content-Length: {}\r\n", body_bytes.len()));
        }
        if let Some(dev) = device_id {
            if !dev.is_empty() {
                req.push_str(&format!("X-Device-Id: {dev}\r\n"));
            }
        }
        if let Some(tok) = bearer_token {
            if !tok.is_empty() {
                req.push_str(&format!("Authorization: Bearer {tok}\r\n"));
            }
        }
        req.push_str("\r\n");
        s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
        if !body_bytes.is_empty() {
            s.write_all(body_bytes).map_err(|e| e.to_string())?;
        }
        let mut raw = Vec::new();
        let _ = s.read_to_end(&mut raw);
        let text = String::from_utf8_lossy(&raw).to_string();
        let status = text
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|c| c.parse::<u16>().ok())
            .unwrap_or(0);
        let resp_body = text
            .split_once("\r\n\r\n")
            .map(|(_, b)| b.to_string())
            .unwrap_or_default();
        Ok(HttpResponse { status, body: resp_body })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn parses_http_and_https_urls() {
        let u1 = parse_url("https://mindmap-viewer-production-adb2.up.railway.app").unwrap();
        assert!(u1.https);
        assert_eq!(u1.host, "mindmap-viewer-production-adb2.up.railway.app");
        assert_eq!(u1.port, 443);
        assert_eq!(u1.base_path, "");

        let u2 = parse_url("http://127.0.0.1:8092/prefix/").unwrap();
        assert!(!u2.https);
        assert_eq!(u2.host, "127.0.0.1");
        assert_eq!(u2.port, 8092);
        assert_eq!(u2.base_path, "/prefix");
        assert_eq!(join_path(&u2.base_path, "/api/hook"), "/prefix/api/hook");

        assert!(parse_url("ftp://example.com").is_err());
    }

    #[test]
    fn roundtrips_post_over_localhost() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = sock.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}";
            let _ = sock.write_all(resp.as_bytes());
            req
        });

        let url = format!("http://127.0.0.1:{port}");
        let res = post_json(
            &url,
            "/api/hook",
            r#"{"events":[]}"#,
            Some("test_tok"),
            "TEST-PC",
            Duration::from_secs(5),
        )
        .expect("HTTP POST should succeed");
        assert_eq!(res.status, 200);
        assert!(res.body.contains("\"ok\":true"));

        let captured = handle.join().unwrap();
        assert!(captured.contains("POST /api/hook HTTP/1.1"));
        assert!(captured.contains("Authorization: Bearer test_tok"));
        assert!(captured.contains("X-Device-Id: TEST-PC"));
    }

    #[cfg(windows)]
    #[test]
    fn winhttp_tls_backend_initializes() {
        let backend = tls_self_check().expect("WinHTTP should initialize");
        assert_eq!(backend, "winhttp-native-tls");
    }
}
