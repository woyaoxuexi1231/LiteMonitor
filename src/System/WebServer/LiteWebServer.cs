using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Text.Json;
using System.Buffers;
using System.Linq;
using LibreHardwareMonitor.Hardware;
using LiteMonitor.src.Core;
using LiteMonitor.src.SystemServices;
using LiteMonitor.src.SystemServices.InfoService;
using System.Diagnostics;

namespace LiteMonitor.src.WebServer
{
    public class LiteWebServer : IDisposable
    {
        private TcpListener? _listener;
        private volatile bool _isRunning = false;
        private int _currentRunningPort = -1;

        public string CurrentPassword { get;set; }

        private readonly Settings _cfg;
        
        // [Refactor] Decoupled WebSocket Logic
        private readonly WebSessionManager _sessionManager;
        
        public static LiteWebServer? Instance { get; private set; }

        public bool IsRunning => _isRunning;
        public int CurrentRunningPort => _isRunning ? _currentRunningPort : -1;

        public LiteWebServer(Settings cfg)
        {
            _cfg = cfg;
            Instance = this;
            // Initialize WebSocket Manager with the data provider delegate
            _sessionManager = new WebSessionManager(
                writer => WriteSnapshotJson(writer, includeTree: false),
                writer => WriteSnapshotJson(writer, includeTree: true));
        }

        public bool Start(out string errorMsg)
        {
            errorMsg = "";
            if (_isRunning) return true;
            if (!_cfg.WebServerEnabled) return true;

            try
            {
                int port = _cfg.WebServerPort;

                try
                {
                    // [Fix] 优先尝试绑定 IPv6Any 并开启 DualMode，以同时支持 IPv4 和 IPv6
                    _listener = new TcpListener(IPAddress.IPv6Any, port);
                    _listener.Server.DualMode = true;
                    _listener.Start();
                }
                catch (Exception)
                {
                    // 如果系统不支持 IPv6，回退到 IPv4
                    _listener = new TcpListener(IPAddress.Any, port);
                    _listener.Start();
                }

                _isRunning = true;
                _currentRunningPort = port;
                CurrentPassword = _cfg.WebServerPassword;

                // 1. 启动监听连接的循环
                Task.Run(ListenLoop);
                
                // 2. 启动 WebSocket 管理器 (广播循环在内部)
                _sessionManager.Start();
                
                return true;
            }
            catch (Exception ex)
            {
                errorMsg = ex.Message;
                Debug.WriteLine("WebServer Start Error: " + ex.Message);
                return false;
            }
        }

        public void Stop()
        {
            _isRunning = false;
            _currentRunningPort = -1;
            try { _listener?.Stop(); } catch { }
            
            // 停止 WebSocket 管理器
            _sessionManager.Stop();
        }

        public void Dispose()
        {
            Stop();
        }

        private async Task ListenLoop()
        {
            while (_isRunning && _listener != null)
            {
                try
                {
                    var client = await _listener.AcceptTcpClientAsync();
                    // [Refactor] All connection handling logic moved to WebSessionManager (now serving as unified ConnectionManager)
                    _ = _sessionManager.HandleClientAsync(client);
                }
                catch (ObjectDisposedException) { break; }
                catch (Exception ex) { Debug.WriteLine(ex.Message); }
            }
        }

        private void WriteSnapshotJson(Utf8JsonWriter writer, bool includeTree = true)
        {
            var hw = HardwareMonitor.Instance;
            if (hw == null)
            {
                writer.WriteStartObject();
                writer.WriteEndObject();
                return;
            }

            // ★★★ 修复：创建列表副本并加锁，防止遍历时 UI 线程修改集合导致崩溃 ★★★
            List<MonitorItemConfig> itemsCopy;
            Dictionary<string, int> groupIndices = new Dictionary<string, int>();
            
            lock (_cfg.MonitorItems)
            {
                // ★★★ 修复：复用主界面 (Panel模式) 的排序逻辑 ★★★
                itemsCopy = _cfg.MonitorItems
                    .GroupBy(x => x.UIGroup)
                    .OrderBy(g => g.Min(x => x.SortIndex))
                    .SelectMany(g => g.OrderBy(x => x.SortIndex))
                    .ToList();

                // 预计算组顺序索引 (基于排序后的列表)
                int gIdx = 0;
                foreach(var item in itemsCopy)
                {
                    if (!groupIndices.ContainsKey(item.UIGroup))
                    {
                        groupIndices[item.UIGroup] = gIdx++;
                    }
                }
            }

            string localIp = hw.GetNetworkIP() ?? "127.0.0.1";

            writer.WriteStartObject();

            // "sys" object
            writer.WriteStartObject("sys");
            writer.WriteString("ip", localIp);
            writer.WriteNumber("port", _currentRunningPort);
            writer.WriteString("uptime", (DateTime.Now - Process.GetCurrentProcess().StartTime).ToString(@"hh\:mm\:ss"));
            writer.WriteNumber("ramTotalGB", Settings.DetectedRamTotalGB);
            writer.WriteNumber("vramTotalGB", Settings.DetectedGpuVramTotalGB);
            writer.WriteEndObject();

            // 完整硬件树体积大，仅 HTTP snapshot 携带；WebSocket 高频推送跳过
            if (includeTree)
                WriteHardwareTree(writer, hw);

            // "items" array（时间线实时值仍依赖监控项）
            writer.WriteStartArray("items");

            foreach (var item in itemsCopy)
            {
                string displayName;
                // [Fix] WebUI should also use MetricLabelResolver to show dynamic names
                string resolved = MetricLabelResolver.ResolveLabel(item);
                if (!string.IsNullOrEmpty(resolved))
                {
                    displayName = resolved;
                }
                else
                {
                    // [Optimization] Use cached keys from MonitorItemConfig
                    string itemsKey = !string.IsNullOrEmpty(item.CachedItemsKey) ? item.CachedItemsKey : UIUtils.Intern("Items." + item.Key);
                    displayName = LanguageManager.T(itemsKey);
                    // 如果翻译失败 (fallback to key suffix)
                    if (displayName.StartsWith("Items.")) displayName = displayName.Split('.')[1];
                }
                
                string groupId = item.UIGroup.ToUpper();
                // [Optimization] Use cached keys
                string groupsKey = !string.IsNullOrEmpty(item.CachedGroupsKey) ? item.CachedGroupsKey : UIUtils.Intern("Groups." + item.UIGroup);
                string groupDisplay = LanguageManager.T(groupsKey);

                string valStr = "";
                string unit = "";
                double pct = 0;
                int status = 0;
                bool isPrimary = false;
                float? rawValue = null;

                if (item.Key.StartsWith("DASH."))
                {
                    // 特殊处理 DASH.HOST 等纯信息项 (以及插件项)
                    string dashKey = item.Key.Substring(5);
                    valStr = InfoService.Instance.GetValue(dashKey);
                    
                    // ★★★ 修复：读取插件写入的颜色状态 (.Color) ★★★
                    // [Optimization] Use cached Dash keys
                    string colorKey = !string.IsNullOrEmpty(item.CachedDashColorKey) ? item.CachedDashColorKey : dashKey + ".Color";
                    string colorStr = InfoService.Instance.GetValue(colorKey);
                    if (int.TryParse(colorStr, out int cVal)) status = cVal;

                    // 读取插件写入的单位 (.Unit)
                    string unitKey = !string.IsNullOrEmpty(item.CachedDashUnitKey) ? item.CachedDashUnitKey : dashKey + ".Unit";
                    string unitStr = InfoService.Instance.GetValue(unitKey);
                    if (!string.IsNullOrEmpty(unitStr)) unit = unitStr;
                }
                else
                {
                    // FPS 会惰性启动 PresentMon；未开启时仍占位推送，前端显示 "—"
                    bool fpsOff = item.Key.Equals("FPS", StringComparison.OrdinalIgnoreCase) && !_cfg.IsAnyEnabled("FPS");

                    // 硬件监控项：无读数时仍推送占位，保证网页总览「一眼看全」
                    float? val = fpsOff ? null : hw.Get(item.Key);

                    if (val.HasValue)
                    {
                        rawValue = val;
                        valStr = MetricUtils.GetValueStr(item.Key, val.Value, false);
                        unit = MetricUtils.GetUnitStr(item.Key, val.Value, MetricUtils.UnitContext.Panel);
                        pct = MetricUtils.GetProgressValue(item.Key, val.Value) * 100.0;
                        status = MetricUtils.GetState(item.Key, val.Value);
                    }
                    else
                    {
                        valStr = "—";
                        unit = "";
                        pct = 0;
                        status = -1; // 前端视为无数据占位
                    }

                    if (item.Key == "BAT.Percent") isPrimary = true;
                    else if (item.Key == "CPU.Load") isPrimary = true;
                    else if (item.Key == "MEM.Load") isPrimary = true;
                    else if (item.Key == "GPU.Core.Load" || item.Key == "GPU.Load") isPrimary = true;
                    else isPrimary = false;
                }

                if (string.IsNullOrEmpty(valStr)) valStr = "—";
                
                writer.WriteStartObject();
                writer.WriteString("k", item.Key);
                writer.WriteString("n", displayName);
                writer.WriteString("gid", groupId);
                writer.WriteString("gn", groupDisplay);
                writer.WriteNumber("gidx", groupIndices.TryGetValue(item.UIGroup, out int idx) ? idx : 999);
                writer.WriteBoolean("on", item.VisibleInPanel);
                writer.WriteString("v", valStr);
                writer.WriteString("u", unit);
                writer.WriteNumber("pct", pct);
                writer.WriteNumber("sts", status);
                writer.WriteBoolean("primary", isPrimary);
                if (rawValue.HasValue) writer.WriteNumber("raw", rawValue.Value);
                writer.WriteEndObject();
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        private static void WriteHardwareTree(Utf8JsonWriter writer, HardwareMonitor hw)
        {
            writer.WriteStartArray("tree");
            try
            {
                var computer = hw.ComputerInstance;
                if (computer?.Hardware == null)
                {
                    writer.WriteEndArray();
                    return;
                }

                lock (hw.SyncLock)
                {
                    foreach (var device in computer.Hardware)
                        WriteHardwareNode(writer, device);
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine("WriteHardwareTree: " + ex.Message);
            }
            writer.WriteEndArray();
        }

        private static void WriteHardwareNode(Utf8JsonWriter writer, IHardware device)
        {
            writer.WriteStartObject();
            writer.WriteString("t", HardwareTypeLabel(device.HardwareType));
            writer.WriteString("n", SanitizeHardwareName(device.Name));
            writer.WriteString("k", device.HardwareType.ToString());

            writer.WriteStartArray("g");
            foreach (var group in device.Sensors.GroupBy(s => s.SensorType).OrderBy(g => g.Key))
            {
                writer.WriteStartObject();
                writer.WriteString("t", SensorTypeLabel(group.Key));
                writer.WriteString("k", group.Key.ToString());
                writer.WriteStartArray("s");
                foreach (var sensor in group)
                {
                    writer.WriteStartObject();
                    writer.WriteString("id", sensor.Identifier?.ToString() ?? "");
                    writer.WriteString("n", sensor.Name ?? "—");
                    writer.WriteString("v", FormatSensorValue(sensor.Value, sensor.SensorType));
                    writer.WriteString("m", FormatSensorValue(sensor.Max, sensor.SensorType));
                    writer.WriteEndObject();
                }
                writer.WriteEndArray();
                writer.WriteEndObject();
            }
            writer.WriteEndArray();

            writer.WriteStartArray("c");
            if (device.SubHardware != null)
            {
                foreach (var sub in device.SubHardware)
                    WriteHardwareNode(writer, sub);
            }
            writer.WriteEndArray();

            writer.WriteEndObject();
        }

        private static string HardwareTypeLabel(HardwareType type) => type switch
        {
            HardwareType.Cpu => "处理器",
            HardwareType.GpuNvidia or HardwareType.GpuAmd or HardwareType.GpuIntel => "显卡",
            HardwareType.Memory => "内存",
            HardwareType.Motherboard => "主板",
            HardwareType.Storage => "硬盘",
            HardwareType.Network => "网卡",
            HardwareType.SuperIO => "IO芯片",
            HardwareType.Cooler => "散热器",
            HardwareType.Battery => "电池",
            _ => type.ToString()
        };

        private static string SensorTypeLabel(SensorType type) => type switch
        {
            SensorType.Temperature => "温度",
            SensorType.Load => "负载",
            SensorType.Fan => "风扇",
            SensorType.Power => "功耗",
            SensorType.Clock => "频率",
            SensorType.Control => "控制",
            SensorType.Voltage => "电压",
            SensorType.Data => "数据",
            SensorType.SmallData => "小型数据",
            SensorType.Throughput => "吞吐量",
            SensorType.Level => "剩余/寿命",
            SensorType.Factor => "系数",
            SensorType.Timing => "时序",
            SensorType.Current => "电流",
            SensorType.Energy => "能量",
            SensorType.Noise => "噪声",
            SensorType.Humidity => "湿度",
            SensorType.Flow => "流量",
            _ => type.ToString()
        };

        private static string FormatSensorValue(float? val, SensorType type)
        {
            if (!val.HasValue) return "—";
            float v = val.Value;

            if (type == SensorType.Data)
                return MetricUtils.FormatDataSize((double)v * 1073741824.0);
            if (type == SensorType.SmallData)
                return MetricUtils.FormatDataSize((double)v * 1048576.0);
            if (type == SensorType.Throughput)
                return MetricUtils.GetValueStr("NET.Throughput", v) + MetricUtils.GetUnitStr("NET.Throughput", v, MetricUtils.UnitContext.Panel);

            string key = type switch
            {
                SensorType.Voltage => "VOLTAGE",
                SensorType.Clock => "CLOCK",
                SensorType.Temperature => "TEMP",
                SensorType.Load or SensorType.Level => "LOAD",
                SensorType.Fan => "FAN",
                SensorType.Power => "POWER",
                SensorType.Current => "BAT.Current",
                _ => ""
            };

            if (string.IsNullOrEmpty(key)) return v.ToString("0.0");
            return MetricUtils.GetValueStr(key, v) + MetricUtils.GetUnitStr(key, v, MetricUtils.UnitContext.Panel);
        }

        private static string SanitizeHardwareName(string? input)
        {
            if (string.IsNullOrEmpty(input)) return "—";
            char[] cleanChars = input.Where(c =>
                char.IsLetterOrDigit(c) ||
                c == ' ' || c == '-' || c == '_' || c == '.' ||
                c == '(' || c == ')' || c == '[' || c == ']' ||
                c == '#' || c == '/' || c == '+'
            ).ToArray();
            string result = new string(cleanChars).Trim();
            while (result.Contains("  ")) result = result.Replace("  ", " ");
            return result.Length < 2 ? "—" : result;
        }
    }
}
