use std::path::Path;

#[derive(Debug, Clone, Default)]
pub struct ForegroundWindow {
    pub app: String,
    pub window_title: String,
}

#[cfg(windows)]
pub fn detect_foreground_window() -> ForegroundWindow {
    use std::ffi::c_void;
    use std::ptr;

    type HModule = *mut c_void;
    type HWnd = *mut c_void;
    type Handle = *mut c_void;
    type FarProc = *const c_void;

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryW(lpLibFileName: *const u16) -> HModule;
        fn GetProcAddress(hModule: HModule, lpProcName: *const u8) -> FarProc;
        fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> Handle;
        fn CloseHandle(hObject: Handle) -> i32;
    }

    type FnGetForegroundWindow = unsafe extern "system" fn() -> HWnd;
    type FnGetWindowTextW = unsafe extern "system" fn(HWnd, *mut u16, i32) -> i32;
    type FnGetWindowThreadProcessId = unsafe extern "system" fn(HWnd, *mut u32) -> u32;
    type FnQueryFullProcessImageNameW =
        unsafe extern "system" fn(Handle, u32, *mut u16, *mut u32) -> i32;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let user32 = unsafe { LoadLibraryW(wide("user32.dll").as_ptr()) };
    if user32.is_null() {
        return ForegroundWindow::default();
    }

    let p_fg = unsafe { GetProcAddress(user32, b"GetForegroundWindow\0".as_ptr()) };
    let p_txt = unsafe { GetProcAddress(user32, b"GetWindowTextW\0".as_ptr()) };
    let p_pid = unsafe { GetProcAddress(user32, b"GetWindowThreadProcessId\0".as_ptr()) };
    if p_fg.is_null() || p_txt.is_null() || p_pid.is_null() {
        return ForegroundWindow::default();
    }

    let get_fg: FnGetForegroundWindow = unsafe { std::mem::transmute(p_fg) };
    let get_txt: FnGetWindowTextW = unsafe { std::mem::transmute(p_txt) };
    let get_pid: FnGetWindowThreadProcessId = unsafe { std::mem::transmute(p_pid) };

    let hwnd = unsafe { get_fg() };
    if hwnd.is_null() {
        return ForegroundWindow::default();
    }

    let mut title_buf = [0u16; 512];
    let n_chars = unsafe { get_txt(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32) };
    let window_title = if n_chars > 0 {
        String::from_utf16_lossy(&title_buf[..n_chars as usize])
    } else {
        String::new()
    };

    let mut pid: u32 = 0;
    unsafe { get_pid(hwnd, &mut pid) };

    let mut app = String::new();
    if pid != 0 {
        let hproc = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if !hproc.is_null() {
            let k32 = unsafe { LoadLibraryW(wide("kernel32.dll").as_ptr()) };
            if !k32.is_null() {
                let p_q = unsafe { GetProcAddress(k32, b"QueryFullProcessImageNameW\0".as_ptr()) };
                if !p_q.is_null() {
                    let query_name: FnQueryFullProcessImageNameW = unsafe { std::mem::transmute(p_q) };
                    let mut path_buf = [0u16; 512];
                    let mut path_len = path_buf.len() as u32;
                    let ok = unsafe { query_name(hproc, 0, path_buf.as_mut_ptr(), &mut path_len) };
                    if ok != 0 && path_len > 0 {
                        let full = String::from_utf16_lossy(&path_buf[..path_len as usize]);
                        let base = full.rsplit(['\\', '/']).next().unwrap_or(&full);
                        app = base.strip_suffix(".exe").or_else(|| base.strip_suffix(".EXE")).unwrap_or(base).to_string();
                    }
                }
            }
            let _ = ptr::null::<u8>();
            unsafe { CloseHandle(hproc) };
        }
    }

    ForegroundWindow { app, window_title }
}

#[cfg(not(windows))]
pub fn detect_foreground_window() -> ForegroundWindow {
    ForegroundWindow::default()
}

/// Capture primary screen to `png_path` using hidden PowerShell (no console window flash).
pub fn capture_primary_screen_png(png_path: &Path) -> bool {
    let p = png_path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; \
         $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \
         $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); \
         $g=[System.Drawing.Graphics]::FromImage($bmp); \
         $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); \
         $bmp.Save('{p}',[System.Drawing.Imaging.ImageFormat]::Png); \
         $g.Dispose(); $bmp.Dispose()"
    );
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-NonInteractive",
        "-Command",
        &script,
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.output() {
        Ok(out) => out.status.success() && png_path.exists(),
        Err(_) => false,
    }
}
