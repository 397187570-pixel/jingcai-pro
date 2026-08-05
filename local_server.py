#!/usr/bin/env python3
# local_server.py — 竞彩智选 Pro 本地开发服务器
# 功能：
#   1) 静态托管当前目录（index.html / css / js ...）
#   2) 同源代理，解决浏览器跨域：
#        /api/sporttery/*  -> https://webapi.sporttery.cn/*
#        /api/football/*   -> https://api.football-data.org/*  (带 X-Auth-Token)
# 用法：
#   python3 local_server.py            # 默认 127.0.0.1:8080
#   python3 local_server.py 9000       # 自定义端口
import http.server
import socketserver
import urllib.request
import urllib.parse
import urllib.error
import os
import sys
import json
import ssl

ROOT = os.path.dirname(os.path.abspath(__file__))
SPORTTERY_BASE = "https://webapi.sporttery.cn"
FOOTBALL_BASE = "https://api.football-data.org"

# 从 .env.local 读取 football-data key（竞彩源不需要 key）
FOOTBALL_KEY = ""
try:
    with open(os.path.join(ROOT, ".env.local"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("FOOTBALL_DATA_KEY="):
                FOOTBALL_KEY = line.split("=", 1)[1].strip().strip('"').strip("'")
except Exception:
    pass

# 竞彩官网为 https，沙箱/本地可能无完整 CA 包，放宽校验
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


class Handler(http.server.SimpleHTTPRequestHandler):
    def _proxy(self, base, subpath, extra_headers=None):
        url = base + subpath
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://www.sporttery.cn/",
        }
        if extra_headers:
            headers.update(extra_headers)
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, context=ctx, timeout=15) as r:
                body = r.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            try:
                payload = e.read()
            except Exception:
                payload = b""
            self.wfile.write(payload or json.dumps(
                {"ok": False, "error": f"HTTP {e.code}"}).encode("utf-8"))
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(
                {"ok": False, "error": str(e)}).encode("utf-8"))

    def do_GET(self):
        if self.path.startswith("/api/sporttery"):
            sub = self.path[len("/api/sporttery"):] or "/"
            return self._proxy(SPORTTERY_BASE, sub)
        if self.path.startswith("/api/football"):
            sub = self.path[len("/api/football"):] or "/"
            return self._proxy(FOOTBALL_BASE, sub,
                               {"X-Auth-Token": FOOTBALL_KEY} if FOOTBALL_KEY else None)
        return super().do_GET()

    def log_message(self, *args):
        pass  # 静默日志


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    os.chdir(ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", port), Handler) as httpd:
        print(f"[jingcai-pro] 本地服务已启动: http://127.0.0.1:{port}/")
        print(f"[jingcai-pro] 竞彩代理 -> {SPORTTERY_BASE}")
        print(f"[jingcai-pro] football-data key: {'已配置' if FOOTBALL_KEY else '未配置'}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[jingcai-pro] 已停止")


if __name__ == "__main__":
    main()
