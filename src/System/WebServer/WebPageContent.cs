using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using LiteMonitor.src.Core;

namespace LiteMonitor.src.WebServer
{
    public static class WebPageContent
    {
        private static string? _cachedFaviconBase64;
        private static string? _cachedHtmlTemplate;
        private static DateTime _cachedHtmlWriteTime = DateTime.MinValue;

        public static string GetAppIconBase64()
        {
            if (_cachedFaviconBase64 != null) return _cachedFaviconBase64;
            try
            {
                using var icon = System.Drawing.Icon.ExtractAssociatedIcon(System.Windows.Forms.Application.ExecutablePath);
                if (icon != null)
                {
                    using var ms = new MemoryStream();
                    icon.ToBitmap().Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                    _cachedFaviconBase64 = Convert.ToBase64String(ms.ToArray());
                    return _cachedFaviconBase64;
                }
            }
            catch { }
            return "";
        }

        public static string GetIndexHtml(bool authRequired)
        {
            string template = LoadHtmlTemplate();
            string iconBase64 = GetAppIconBase64();
            string favicon = !string.IsNullOrEmpty(iconBase64)
                ? $"<link rel='icon' type='image/png' href='data:image/png;base64,{iconBase64}'>"
                : "";

            return template
                .Replace("{{FAVICON}}", favicon)
                .Replace("{{AUTH_REQUIRED}}", authRequired ? "true" : "false");
        }

        private static string LoadHtmlTemplate()
        {
            try
            {
                string path = Path.Combine(AppContext.BaseDirectory, "web", "index.html");
                if (File.Exists(path))
                {
                    var writeTime = File.GetLastWriteTimeUtc(path);
                    if (_cachedHtmlTemplate == null || writeTime != _cachedHtmlWriteTime)
                    {
                        _cachedHtmlTemplate = File.ReadAllText(path, Encoding.UTF8);
                        _cachedHtmlWriteTime = writeTime;
                    }
                    return _cachedHtmlTemplate;
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine("Load web index.html failed: " + ex.Message);
            }

            return FallbackHtml;
        }

        private const string FallbackHtml = @"<!DOCTYPE html><html><body style='font-family:sans-serif;padding:40px'>
<h1>LiteMonitor Web</h1>
<p>Missing web/index.html. Please reinstall or rebuild.</p>
</body></html>";
    }

    public static class WebHistoryApi
    {
        private sealed class PanelDef
        {
            public string Id { get; init; } = "";
            public string Title { get; init; } = "";
            public string Kind { get; init; } = "health"; // health | volume | value
            public string? Primary { get; init; }
            public string? Secondary { get; init; }
            public string? A { get; init; }
            public string? B { get; init; }
            public string? ALabel { get; init; }
            public string? BLabel { get; init; }
            public string Sev { get; init; } = "pct"; // pct | ram | temp | none
            public string Fmt { get; init; } = "auto";
            public string Rule { get; init; } = "";
        }

        private static readonly PanelDef[] Panels =
        {
            new() { Id = "cpu", Title = "CPU", Kind = "health", Primary = "CPU.Load", Secondary = "CPU.Temp", Sev = "pctTemp",
                Rule = "<70% · 70–90% · ≥90% · temp 75/85°C · bar = worse of util/temp" },
            new() { Id = "gpu", Title = "GPU", Kind = "health", Primary = "GPU.Load", Secondary = "GPU.Temp", Sev = "pctTemp",
                Rule = "<70% · 70–90% · ≥90% · temp 75/85°C · bar = worse of util/temp" },
            new() { Id = "ram", Title = "RAM", Kind = "health", Primary = "MEM.Load", Sev = "ram",
                Rule = "<80% · 80–90% · ≥90%" },
            new() { Id = "vram", Title = "VRAM", Kind = "health", Primary = "GPU.VRAM", Sev = "ram",
                Rule = "<80% · 80–90% · ≥90%" },
            new() { Id = "net", Title = "NET", Kind = "volume", A = "NET.Down", B = "NET.Up", ALabel = "↓", BLabel = "↑",
                Rule = "bar height = relative traffic · totals = sum for selected range" },
            new() { Id = "diskio", Title = "DISK I/O", Kind = "volume", A = "DISK.Read", B = "DISK.Write", ALabel = "R", BLabel = "W",
                Rule = "bar height = relative read+write volume" },
            new() { Id = "diskTemp", Title = "DISK Temp", Kind = "health", Primary = "DISK.Temp", Sev = "temp",
                Rule = "<75°C · 75–85°C · ≥85°C" },
            new() { Id = "moboTemp", Title = "MOBO Temp", Kind = "health", Primary = "MOBO.Temp", Sev = "temp",
                Rule = "<75°C · 75–85°C · ≥85°C" },
            new() { Id = "cpuPower", Title = "CPU Power", Kind = "value", Primary = "CPU.Power", Sev = "none", Fmt = "W",
                Rule = "average power per bucket" },
            new() { Id = "gpuPower", Title = "GPU Power", Kind = "value", Primary = "GPU.Power", Sev = "none", Fmt = "W",
                Rule = "average power per bucket" },
            new() { Id = "cpuClock", Title = "CPU Clock", Kind = "value", Primary = "CPU.Clock", Sev = "none", Fmt = "MHz",
                Rule = "average frequency per bucket" },
            new() { Id = "gpuClock", Title = "GPU Clock", Kind = "value", Primary = "GPU.Clock", Sev = "none", Fmt = "MHz",
                Rule = "average frequency per bucket" },
            new() { Id = "fps", Title = "FPS", Kind = "value", Primary = "FPS", Sev = "none", Fmt = "FPS",
                Rule = "average FPS per bucket" },
            new() { Id = "cpuFan", Title = "CPU Fan", Kind = "value", Primary = "CPU.Fan", Sev = "none", Fmt = "RPM",
                Rule = "average RPM per bucket" },
            new() { Id = "gpuFan", Title = "GPU Fan", Kind = "value", Primary = "GPU.Fan", Sev = "none", Fmt = "RPM",
                Rule = "average RPM per bucket" },
            new() { Id = "caseFan", Title = "Case Fan", Kind = "value", Primary = "CASE.Fan", Sev = "none", Fmt = "RPM",
                Rule = "average RPM per bucket" },
            new() { Id = "cpuPump", Title = "CPU Pump", Kind = "value", Primary = "CPU.Pump", Sev = "none", Fmt = "RPM",
                Rule = "average RPM per bucket" },
            new() { Id = "bat", Title = "Battery", Kind = "health", Primary = "BAT.Percent", Sev = "ram",
                Rule = "charge level" },
            new() { Id = "batPower", Title = "Battery Power", Kind = "value", Primary = "BAT.Power", Sev = "none", Fmt = "W",
                Rule = "average battery power" },
        };

        private static readonly string[] TrackedKeys = HardwareHistoryLogger.SupportedKeys.ToArray();

        public static byte[] BuildHistoryJson(string mode, string? day)
        {
            bool isLive = !string.Equals(mode, "day", StringComparison.OrdinalIgnoreCase);
            DateTime now = DateTime.Now;
            DateTime from;
            DateTime to;
            int bucketCount;
            double bucketSeconds;
            string axisL, axisR;
            string? dayKey = null;

            if (isLive)
            {
                bucketCount = 30;
                bucketSeconds = 60;
                to = now;
                from = now.AddMinutes(-30);
                axisL = "30 min ago";
                axisR = "now";
            }
            else
            {
                if (string.IsNullOrWhiteSpace(day) || !DateTime.TryParse(day, out var parsedDay))
                    parsedDay = now.Date;
                dayKey = parsedDay.ToString("yyyy-MM-dd");
                from = parsedDay.Date;
                to = from.AddDays(1);
                bucketCount = 24;
                bucketSeconds = 3600;
                axisL = "00:00";
                axisR = "24:00";
            }

            var points = HardwareHistoryLogger.GetPoints(from, to);
            var buckets = new List<Dictionary<string, object?>>(bucketCount);
            var statsAcc = new Dictionary<string, (double max, double sum, double n)>(StringComparer.OrdinalIgnoreCase);
            var flags = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);

            bool isToday = !isLive && from.Date == now.Date;

            for (int i = 0; i < bucketCount; i++)
            {
                DateTime bStart = from.AddSeconds(bucketSeconds * i);
                DateTime bEnd = from.AddSeconds(bucketSeconds * (i + 1));

                bool empty = isLive
                    ? false
                    : (isToday && i > now.Hour);

                // live: empty if no samples in window
                var slice = points.Where(p => p.Time >= bStart && p.Time < bEnd).ToList();
                if (empty || slice.Count == 0)
                {
                    buckets.Add(new Dictionary<string, object?>
                    {
                        ["empty"] = true,
                        ["i"] = i,
                        ["v"] = new Dictionary<string, double>(),
                        ["bytes"] = new Dictionary<string, double>()
                    });
                    continue;
                }

                var vals = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
                var bytes = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);

                foreach (string key in TrackedKeys)
                {
                    double avg = AvgKey(slice, key);
                    if (avg < 0) continue;
                    vals[key] = avg;
                    flags[key] = true;
                    Accumulate(key, avg, statsAcc);

                    if (IsSpeedKey(key))
                        bytes[key] = avg * bucketSeconds;
                }

                buckets.Add(new Dictionary<string, object?>
                {
                    ["empty"] = false,
                    ["i"] = i,
                    ["v"] = vals,
                    ["bytes"] = bytes
                });
            }

            var stats = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            foreach (var kv in statsAcc)
            {
                stats[kv.Key] = new
                {
                    max = kv.Value.n > 0 ? kv.Value.max : -1,
                    avg = kv.Value.n > 0 ? kv.Value.sum / kv.Value.n : -1
                };
            }

            var panelPayload = Panels.Select(p => new
            {
                id = p.Id,
                title = p.Title,
                kind = p.Kind,
                primary = p.Primary,
                secondary = p.Secondary,
                a = p.A,
                b = p.B,
                aLabel = p.ALabel,
                bLabel = p.BLabel,
                sev = p.Sev,
                fmt = p.Fmt,
                rule = p.Rule
            }).ToList();

            var payload = new
            {
                mode = isLive ? "live" : "day",
                day = dayKey,
                retentionDays = HardwareHistoryLogger.RetentionDays,
                bucketCount,
                bucketSeconds,
                pointCount = points.Count,
                axisL,
                axisR,
                flags,
                buckets,
                stats,
                panels = panelPayload
            };

            return Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
        }

        // keep old signature for any callers
        public static byte[] BuildHistoryJson(int sec)
        {
            if (sec >= 86400) return BuildHistoryJson("day", DateTime.Now.ToString("yyyy-MM-dd"));
            return BuildHistoryJson("live", null);
        }

        public static string HistoryDirectory
        {
            get
            {
                string? dir = Path.GetDirectoryName(HardwareHistoryLogger.FilePath);
                return string.IsNullOrEmpty(dir) ? AppContext.BaseDirectory : dir;
            }
        }

        private static bool IsSpeedKey(string key)
        {
            return key.StartsWith("NET.", StringComparison.OrdinalIgnoreCase)
                || key.StartsWith("DISK.Read", StringComparison.OrdinalIgnoreCase)
                || key.StartsWith("DISK.Write", StringComparison.OrdinalIgnoreCase);
        }

        private static double AvgKey(List<HardwareHistoryPoint> slice, string key)
        {
            double sum = 0;
            int n = 0;
            foreach (var p in slice)
            {
                if (p.Values == null) continue;
                if (!TryGetValue(p.Values, key, out var v) || v.Count <= 0) continue;
                sum += v.Avg;
                n++;
            }
            return n > 0 ? sum / n : -1;
        }

        private static bool TryGetValue(Dictionary<string, HardwareHistoryValue> dict, string key, out HardwareHistoryValue value)
        {
            if (dict.TryGetValue(key, out value!)) return true;
            foreach (var kv in dict)
            {
                if (string.Equals(kv.Key, key, StringComparison.OrdinalIgnoreCase))
                {
                    value = kv.Value;
                    return true;
                }
            }
            value = null!;
            return false;
        }

        private static void Accumulate(string key, double v, Dictionary<string, (double max, double sum, double n)> acc)
        {
            if (v < 0) return;
            if (!acc.TryGetValue(key, out var cur))
                acc[key] = (v, v, 1);
            else
                acc[key] = (Math.Max(cur.max, v), cur.sum + v, cur.n + 1);
        }
    }
}
