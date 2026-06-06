/**
 * SoundBridge Launcher - WinForms 启动器
 * 编译: csc /platform:x64 /out:SoundBridge.exe SoundBridge.cs /r:System.Windows.Forms.dll /r:System.Drawing.dll
 * 
 * 功能：
 * - 自动检测/下载 Node.js
 * - 自动安装依赖
 * - 启动 server.js (Relay 模式)
 * - 显示 QR 码和连接状态
 * - 托盘图标，关闭到托盘
 */

using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using System.Drawing;
using System.Threading;
using System.Text;

class SoundBridge : Form
{
    private Process nodeProcess;
    private NotifyIcon trayIcon;
    private RichTextBox logBox;
    private bool isRunning = false;

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
        StartServer();
    }

    void SetupWindow()
    {
        Text = "SoundBridge";
        Size = new Size(520, 420);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Icon = SystemIcons.Application;

        // 标题
        var title = new Label();
        title.Text = "🔊 SoundBridge";
        title.Font = new Font("Microsoft YaHei", 16, FontStyle.Bold);
        title.ForeColor = Color.FromArgb(79, 70, 229);
        title.AutoSize = true;
        title.Location = new Point(20, 15);
        Controls.Add(title);

        var subtitle = new Label();
        subtitle.Text = "手机变无线麦克风 & 无线音箱";
        subtitle.Font = new Font("Microsoft YaHei", 9);
        subtitle.ForeColor = Color.Gray;
        subtitle.AutoSize = true;
        subtitle.Location = new Point(22, 52);
        Controls.Add(subtitle);

        // 状态
        var statusLabel = new Label();
        statusLabel.Text = "状态：";
        statusLabel.Font = new Font("Microsoft YaHei", 9);
        statusLabel.Location = new Point(20, 80);
        Controls.Add(statusLabel);

        var statusValue = new Label();
        statusValue.Name = "statusValue";
        statusValue.Text = "启动中...";
        statusValue.Font = new Font("Microsoft YaHei", 9, FontStyle.Bold);
        statusValue.ForeColor = Color.FromArgb(79, 70, 229);
        statusValue.Location = new Point(65, 80);
        statusValue.AutoSize = true;
        Controls.Add(statusValue);

        // 日志区域
        logBox = new RichTextBox();
        logBox.Location = new Point(20, 110);
        logBox.Size = new Size(460, 240);
        logBox.Font = new Font("Consolas", 9);
        logBox.BackColor = Color.FromArgb(10, 10, 26);
        logBox.ForeColor = Color.FromArgb(200, 210, 230);
        logBox.BorderStyle = BorderStyle.FixedSingle;
        logBox.ReadOnly = true;
        logBox.ScrollBars = RichTextBoxScrollBars.Vertical;
        Controls.Add(logBox);

        // 底部
        var footer = new Label();
        footer.Text = "v1.0 · slwen.cn · 关闭窗口最小化到托盘";
        footer.Font = new Font("Microsoft YaHei", 8);
        footer.ForeColor = Color.FromArgb(100, 100, 120);
        footer.AutoSize = true;
        footer.Location = new Point(20, 360);
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
        string appDir = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
        string serverJs = Path.Combine(appDir, "server.js");
        string nodeExe = Path.Combine(appDir, "node", "node.exe");

        // 尝试系统 PATH 中的 node
        if (!File.Exists(nodeExe))
        {
            // 查找系统安装的 node
            try
            {
                var which = Process.Start(new ProcessStartInfo
                {
                    FileName = "where",
                    Arguments = "node",
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
                string output = which.StandardOutput.ReadToEnd();
                which.WaitForExit();
                if (which.ExitCode == 0 && !string.IsNullOrWhiteSpace(output))
                {
                    nodeExe = output.Split('\n')[0].Trim();
                }
            }
            catch { }
        }

        if (!File.Exists(nodeExe) || !File.Exists(serverJs))
        {
            SetStatus("错误：找不到 Node.js 或 server.js", Color.Red);
            Log("请确保 node.exe 和 server.exe 在同一目录");
            Log("appDir: " + appDir);
            return;
        }

        SetStatus("正在启动...", Color.Orange);

        var psi = new ProcessStartInfo
        {
            FileName = nodeExe,
            Arguments = "server.js",
            WorkingDirectory = appDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };

        try
        {
            nodeProcess = new Process { StartInfo = psi, EnableRaisingEvents = true };
            psi.EnvironmentVariables["RELAY_URL"] = "wss://slwen.cn/voice/ws";
            psi.EnvironmentVariables["RELAY_PUBLIC_URL"] = "https://slwen.cn/voice/";
            nodeProcess.OutputDataReceived += (s, e) => { if (e.Data != null) Invoke(new Action(() => Log(e.Data))); };
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
