"""
Local Upwork fetch proxy for n8n — fetches via Chrome CDP (same browser that holds cf_clearance).

Start:  python c:/n8n/upwork_fetch_service.py
n8n:    HTTP Request GET http://127.0.0.1:9877/fetch/jobs  →  response body = HTML in `data` field

Keep this running while n8n workflows execute. Chrome automation profile opens on first fetch.
"""

from __future__ import annotations

import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import refresh_upwork_cookies as ruc

PORT = 9877
JOBS_URL = ruc.JOBS_URL


def fetch_url(url: str) -> dict:
    html, cookies = ruc.fetch_html_via_cdp(url, wait_seconds=45)
    if cookies:
        ruc.save_cookies(cookies)

    blocked = ruc.page_looks_blocked(html) if html else True
    has_jobs = ruc.html_has_jobs(html)
    return {
        "html": html,
        "length": len(html),
        "blocked": blocked,
        "hasJobs": has_jobs,
        "hasCfClearance": "cf_clearance" in cookies,
        "cookieCount": len(cookies),
    }


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _html(self, code: int, html: str) -> None:
        data = html.encode("utf-8", errors="replace")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path)
        route = path.path.rstrip("/") or "/"

        if route == "/health":
            self._json(200, {"ok": True, "cdp": ruc.cdp_alive(), "port": PORT})
            return

        if route == "/cookies":
            try:
                data = json.loads(ruc.COOKIE_JSON.read_text(encoding="utf-8"))
            except Exception:
                data = {}
            self._json(200, data)
            return

        if route in ("/fetch/jobs", "/fetch"):
            url = JOBS_URL
            if route == "/fetch":
                qs = parse_qs(path.query)
                url = (qs.get("url") or [""])[0]
                if not url:
                    self._json(400, {"error": "Missing ?url="})
                    return

            result = fetch_url(url)
            if result["blocked"] or not result["html"]:
                self._json(
                    403,
                    {
                        "error": "Cloudflare block or empty page",
                        "blocked": result["blocked"],
                        "length": result["length"],
                        "hasCfClearance": result["hasCfClearance"],
                        "hasJobs": result["hasJobs"],
                    },
                )
                return
            self._html(200, result["html"])
            return

        self._json(404, {"error": "Not found", "routes": ["/health", "/cookies", "/fetch/jobs", "/fetch?url="]})

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path.rstrip("/") == "/refresh":
            if not ruc.cdp_alive():
                ruc.launch_chrome_with_debug()
                time.sleep(3)
            cookies = ruc.refresh_clearance_via_cdp(wait_seconds=90) or ruc.cookies_from_cdp()
            if cookies:
                ruc.save_cookies(cookies)
            self._json(200, {"ok": "cf_clearance" in cookies, "cookies": list(cookies.keys())})
            return
        self._json(404, {"error": "Not found"})

    def log_message(self, fmt: str, *args) -> None:
        print(f"[upwork-fetch] {fmt % args}")


def main() -> None:
    print(f"Upwork fetch service http://127.0.0.1:{PORT}")
    print("  GET /fetch/jobs  — HTML for n8n workflow")
    print("  POST /refresh    — refresh cf_clearance")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
