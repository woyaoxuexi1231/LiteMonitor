using System;
using System.Diagnostics;
using LiteMonitor.src.WebServer;
using LiteMonitor.src.SystemServices;

namespace LiteMonitor.src.Core.Actions
{
    public static class WebActions
    {
        public static void OpenWebMonitor(Settings cfg)
        {
            if (cfg == null) return;

            // 双击打开时自动启用并启动网页服务
            if (!cfg.WebServerEnabled)
            {
                cfg.WebServerEnabled = true;
                cfg.Save();
            }

            AppActions.ApplyWebServer(cfg);

            int port = 0;
            if (LiteWebServer.Instance != null && LiteWebServer.Instance.IsRunning)
            {
                port = LiteWebServer.Instance.CurrentRunningPort;
            }
            if (port <= 0)
            {
                port = cfg.WebServerPort;
            }

            if (port <= 0) return;

            // 本机打开优先 localhost，避免防火墙/多网卡导致打不开
            string url = $"http://localhost:{port}";
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                Debug.WriteLine("Failed to open web monitor: " + ex.Message);
                try
                {
                    if (HardwareMonitor.Instance != null)
                    {
                        string ip = HardwareMonitor.Instance.GetNetworkIP();
                        if (!string.IsNullOrEmpty(ip) && ip != "0.0.0.0" && ip != "127.0.0.1")
                        {
                            Process.Start(new ProcessStartInfo($"http://{ip}:{port}") { UseShellExecute = true });
                        }
                    }
                }
                catch { }
            }
        }
    }
}
