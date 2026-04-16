using System;
using System.Diagnostics;
using System.Net;
using System.IO;

// Orbit silent installer stub
// Server patches the token placeholder before serving this EXE.
// Do NOT edit the _T constant length (60 X's between the colons).
class OrbitInstall {
    const string _T = "ORBT:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX:TRBO";
    const string _S = "https://mindmap-viewer-production-adb2.up.railway.app";

    [STAThread]
    static void Main() {
        try {
            int s = _T.IndexOf(':') + 1;
            int e = _T.LastIndexOf(':');
            if (e <= s) return;
            string token = _T.Substring(s, e - s).TrimEnd('X');
            if (token.Length < 8) return; // not patched — do nothing

            string tmp = Path.Combine(Path.GetTempPath(), "orbit-setup.exe");
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2
            using (var wc = new WebClient())
                wc.DownloadFile(_S + "/setup/download", tmp);

            Process.Start(new ProcessStartInfo {
                FileName = tmp,
                Arguments = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TOKEN=\"" + token + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            });
        } catch { }
    }
}
