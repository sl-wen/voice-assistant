/**
 * SoundBridge All-in-One Launcher
 * 
 * 打包步骤：
 * 1. 编译此文件: csc /platform:x64 /out:SoundBridge.exe SoundBridge.cs /r:System.Windows.Forms.dll /r:System.Drawing.dll
 * 2. 把所有运行文件打成 ZIP: 
 *    server.js, package.json, node_modules/, public/, audio-capture.cs
 * 3. 把 ZIP 追加到 EXE 末尾: 
 *    copy /b SoundBridge.exe + SoundBridge.zip SoundBridge-Setup.exe
 * 
 * 运行时:
 * - 检测到尾部有 ZIP → 解压到 %TEMP%\SoundBridge\ → 启动
 * - 检测不到 → 直接在当前目录找 server.js 启动
 */

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Windows.Forms;
using System.Drawing;
using System.Text;
using System.Reflection;

class SoundBridge : Form
{
    private Process nodeProcess;
    private NotifyIcon trayIcon;
    private RichTextBox logBox;
    private bool isRunning = false;
    private string runDir;

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SoundBridge());
    }

    public SoundBridge()
    {
        SetupWindow();
        SetupTray();
        PrepareAndStart();
    }

    /// <summary>
    /// 准备运行环境：解压内嵌 ZIP 或使用当前目录
    /// </summary>
    void PrepareAndStart()
    {
        string exePath = Assembly.GetExecutingAssembly().Location;
        runDir = Path.GetDirectoryName(exePath);

        // 检查 EXE 尾部是否有嵌入的 ZIP
        byte[] zipSignature = new byte[] { 0x50, 0x4B, 0x03, 0x04 }; // PK\x03\x04
        byte[] buffer = new byte[4];

        using (var fs = new FileStream(exePath, FileMode.Open, FileAccess.Read))
        {
            // 从后往前找 ZIP 签名（ZIP 文件的 End of Central Directory）
            // EOCD signature: 50 4B 05 06
            byte[] eocdSig = new byte[] { 0x50, 0x4B, 0x05, 0x06 };
            long pos = fs.Length - 22; // EOCD min 22 bytes from end
            bool foundZip = false;

            while (pos > fs.Length / 2 && pos > 0)
            {
                fs.Position = pos;
                fs.Read(buffer, 0, 4);
                if (buffer[0] == eocdSig[0] && buffer[1] == eocdSig[1] &&
                    buffer[2] == eocdSig[2] && buffer[3] == eocdSig[3])
                {
                    foundZip = true;
                    break;
                }
                pos--;
            }

            if (foundZip)
            {
                Log("检测到内嵌数据包，正在解压...");
                string tempDir = Path.Combine(Path.GetTempPath(), "SoundBridge_" + DateTime.Now.Ticks);
                
                // 读取 ZIP 部分：从第一个 PK\x03\x04 开始
                // 简单方法：把整个 EXE 当 ZIP 读（ZipArchive 会自动跳过非 ZIP 前缀）
                fs.Position = 0;
                
                // 找到第一个 PK\x03\x04
                long zipStart = -1;
                long searchStart = fs.Length / 2; // ZIP 肯定在后半部分
                fs.Position = searchStart;
                while (fs.Position < fs.Length - 4)
                {
                    fs.Read(buffer, 0, 4);
                    if (buffer[0] == zipSignature[0] && buffer[1] == zipSignature[1] &&
                        buffer[2] == zipSignature[2] && buffer[3] == zipSignature[3])
                    {
                        zipStart = fs.Position - 4;
                        break;
                    }
                }

                if (zipStart >= 0)
                {
                    // 提取 ZIP 数据
                    int zipLen = (int)(fs.Length - zipStart);
                    byte[] zipData = new byte[zipLen];
                    fs.Position = zipStart;
                    fs.Read(zipData, 0, zipLen);

                    // 解压
                    Directory.CreateDirectory(tempDir);
                    using (var ms = new MemoryStream(zipData))
                    using (var archive = new ZipArchive(ms, ZipArchiveMode.Read))
                    {
                        foreach (var entry in archive.Entries)
                        {
                            string dest = Path.Combine(tempDir, entry.FullName);
                            string dir = Path.GetDirectoryName(dest);
                            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                            if (entry.Length > 0)
                            {
                                using (var es = entry.Open())
                                using (var df = File.Create(dest))
                                {
                                    es.CopyTo(df);
                                }
                            }
                        }
                    }
                    runDir = tempDir;
                    Log("解压完成: " + tempDir);
                }
            }
        }

        StartServer();
    }

    void SetupWindow()
    {
        Text = "SoundBridge";
        Size = new Size(540, 440);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;

        var title = new Label();
        title.Text = "🔊 SoundBridge";
        title.Font = new Font("Microsoft YaHei", 16, FontStyle.Bold);
        title.ForeColor = Color.FromArgb(79, 70, 229);
        title.AutoSize = true;
        title.Location = new Point(20, 12);
        Controls.Add(title);

        var subtitle = new Label();
        subtitle.Text = "手机变无线麦克风 & 无线音箱";
        subtitle.Font = new Font("Microsoft YaHei", 9);
        subtitle.ForeColor = Color.Gray;
        subtitle.AutoSize = true;
        subtitle.Location = new Point(22, 50);
        Controls.Add(subtitle);

        var statusLabel = new Label();
        statusLabel.Text = "状态：";
        statusLabel.Font = new Font("Microsoft YaHei", 9);
        statusLabel.Location = new Point(20, 78);
        Controls.Add(statusLabel);

        var statusValue = new Label();
        statusValue.Name = "statusValue";
        statusValue.Text = "准备中...";
        statusValue.Font = new Font("Microsoft YaHei", 9, FontStyle.Bold);
        statusValue.ForeColor = Color.FromArgb(79, 70, 229);
        statusValue.Location = new Point(65, 78);
        statusValue.AutoSize = true;
        Controls.Add(statusValue);

        logBox = new RichTextBox();
        logBox.Location = new Point(20, 108);
        logBox.Size = new Size(480, 250);
        logBox.Font = new Font("Consolas", 7);
        logBox.BackColor = Color.FromArgb(10, 10, 26);
        logBox.ForeColor = Color.FromArgb(200, 210, 230);
        logBox.BorderStyle = BorderStyle.FixedSingle;
        logBox.ReadOnly = true;
        logBox.ScrollBars = RichTextBoxScrollBars.Vertical;
        logBox.WordWrap = false;
        Controls.Add(logBox);

        var footer = new Label();
        footer.Text = "SoundBridge v1.0 · slwen.cn · 关闭窗口最小化到托盘";
        footer.Font = new Font("Microsoft YaHei", 8);
        footer.ForeColor = Color.FromArgb(100, 100, 120);
        footer.AutoSize = true;
        footer.Location = new Point(20, 370);
        Controls.Add(footer);
    }

    void SetupTray()
    {
        trayIcon = new NotifyIcon();
        trayIcon.Icon = SystemIcons.Application;
        trayIcon.Text = "SoundBridge";
        trayIcon.Visible = true;
        trayIcon.DoubleClick += (s, e) => { Show(); WindowState = FormWindowState.Normal; };

        var menu = new ContextMenuStrip();
        menu.Items.Add("显示主窗口", null, (s, e) => { Show(); WindowState = FormWindowState.Normal; });
        menu.Items.Add("退出", null, (s, e) => { Cleanup(); Application.Exit(); });
        trayIcon.ContextMenuStrip = menu;
    }

    void StartServer()
    {
        string serverJs = Path.Combine(runDir, "server.js");
        if (!File.Exists(serverJs))
        {
            SetStatus("错误：找不到 server.js", Color.Red);
            Log("运行目录: " + runDir);
            Log("请确保 server.js 在同一目录或打包在 EXE 中");
            return;
        }

        // 查找 node.exe
        string nodeExe = FindNode();
        if (nodeExe == null)
        {
            SetStatus("错误：找不到 Node.js", Color.Red);
            Log("请安装 Node.js: https://nodejs.org/");
            return;
        }

        Log("Node.js: " + nodeExe);
        SetStatus("正在启动...", Color.Orange);

        var psi = new ProcessStartInfo
        {
            FileName = nodeExe,
            Arguments = "server.js",
            WorkingDirectory = runDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };

        try
        {
            nodeProcess = new Process { StartInfo = psi, EnableRaisingEvents = true };
            psi.EnvironmentVariables["RELAY_URL"] = "wss://slwen.cn/voice/ws";
            psi.EnvironmentVariables["RELAY_PUBLIC_URL"] = "https://slwen.cn/voice/";
            nodeProcess.OutputDataReceived += (s, e) => { if (e.Data != null) { var f = FilterOutput(e.Data); if (f != null) Invoke(new Action(() => Log(f))); } };
            nodeProcess.ErrorDataReceived += (s, e) => { if (e.Data != null) Invoke(new Action(() => Log("[ERR] " + e.Data))); };
            nodeProcess.Start();
            nodeProcess.BeginOutputReadLine();
            nodeProcess.BeginErrorReadLine();
            isRunning = true;
            SetStatus("运行中", Color.Green);
        }
        catch (Exception ex)
        {
            SetStatus("启动失败", Color.Red);
            Log("错误: " + ex.Message);
        }
    }

    string FindNode()
    {
        // 1. 同目录下 node/node.exe
        string local = Path.Combine(runDir, "node", "node.exe");
        if (File.Exists(local)) return local;

        // 2. 同目录下 node.exe
        local = Path.Combine(runDir, "node.exe");
        if (File.Exists(local)) return local;

        // 3. 系统 PATH
        try
        {
            var p = Process.Start(new ProcessStartInfo
            {
                FileName = "where",
                Arguments = "node",
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            });
            string output = p.StandardOutput.ReadToEnd();
            p.WaitForExit();
            if (p.ExitCode == 0 && !string.IsNullOrWhiteSpace(output))
            {
                string path = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)[0].Trim();
                if (File.Exists(path)) return path;
            }
        }
        catch { }

        return null;
    }

    string FilterOutput(string line)
    {
        if (line.Trim().Length > 0 && line.Replace("=", "").Replace("═", "").Trim().Length == 0)
            return null;
        return line;
    }

    void Log(string msg)
    {
        if (logBox.InvokeRequired) { Invoke(new Action(() => Log(msg))); return; }
        logBox.AppendText(msg + "\n");
        logBox.ScrollToCaret();
    }

    void SetStatus(string text, Color color)
    {
        if (InvokeRequired) { Invoke(new Action(() => SetStatus(text, color))); return; }
        var ctrl = Controls.Find("statusValue", true);
        if (ctrl.Length > 0) { ctrl[0].Text = text; ctrl[0].ForeColor = color; }
    }

    void Cleanup()
    {
        if (nodeProcess != null && !nodeProcess.HasExited)
        {
            try { nodeProcess.Kill(); } catch { }
        }
        trayIcon.Visible = false;
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing && isRunning)
        {
            e.Cancel = true;
            Hide();
            trayIcon.ShowBalloonTip(2000, "SoundBridge", "正在后台运行，双击托盘图标恢复", ToolTipIcon.Info);
        }
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { Cleanup(); }
        base.Dispose(disposing);
    }
}
