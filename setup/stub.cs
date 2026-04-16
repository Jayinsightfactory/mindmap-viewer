using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Windows.Forms;

// Orbit AI silent installer stub
// Shows a single name-input dialog, registers with the server, then installs silently.
[assembly: System.Reflection.AssemblyTitle("Orbit AI 설치")]
[assembly: System.Reflection.AssemblyProduct("Orbit AI")]
[assembly: System.Reflection.AssemblyVersion("2.0.0.0")]

class OrbitInstall {
    const string SERVER = "https://mindmap-viewer-production-adb2.up.railway.app";

    [STAThread]
    static void Main() {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        // 이름 입력 다이얼로그
        string name = ShowNameDialog();
        if (string.IsNullOrEmpty(name)) return;

        try {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2

            // 서버에 이름 등록 → 토큰 발급
            var wc = new WebClient();
            wc.Headers[HttpRequestHeader.ContentType] = "application/json; charset=utf-8";
            wc.Encoding = System.Text.Encoding.UTF8;
            string json = "{\"name\":\"" + name.Replace("\\", "").Replace("\"", "") + "\"}";
            string resp = wc.UploadString(SERVER + "/api/setup/register-name", json);

            // {"token":"orbit_xxx"} 파싱
            int ts = resp.IndexOf("\"token\":\"");
            if (ts < 0) return;
            ts += 9;
            int te = resp.IndexOf("\"", ts);
            string token = (te > ts) ? resp.Substring(ts, te - ts) : "";
            if (token.Length < 16) return;

            // OrbitAI-Setup.exe 다운로드
            string tmp = Path.Combine(Path.GetTempPath(), "orbit-setup.exe");
            wc.DownloadFile(SERVER + "/setup/download", tmp);

            // 완전 숨김 실행
            Process.Start(new ProcessStartInfo {
                FileName = tmp,
                Arguments = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TOKEN=\"" + token + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            });
        } catch { }
    }

    static string ShowNameDialog() {
        var form = new Form {
            Text = "Orbit AI 설치",
            Width = 340,
            Height = 150,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            StartPosition = FormStartPosition.CenterScreen,
            Font = new Font("맑은 고딕", 10)
        };

        var lbl = new Label {
            Text = "이름을 입력해주세요",
            Left = 16, Top = 18, Width = 290, AutoSize = true
        };

        var tb = new TextBox {
            Left = 16, Top = 44, Width = 290
        };

        var btn = new Button {
            Text = "설치 시작",
            Left = 226, Top = 76, Width = 80, Height = 28,
            BackColor = Color.FromArgb(37, 99, 235),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat
        };
        btn.FlatAppearance.BorderSize = 0;

        string result = "";
        btn.Click += (s, e) => {
            string v = tb.Text.Trim();
            if (v.Length < 1) { MessageBox.Show("이름을 입력해주세요.", "Orbit AI", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            result = v;
            form.Close();
        };

        form.AcceptButton = btn;
        form.Controls.AddRange(new Control[] { lbl, tb, btn });
        form.ShowDialog();
        return result;
    }
}
