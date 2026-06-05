"""
Refresh and export Upwork cookies (including cf_clearance) for n8n.

Cloudflare sets cf_clearance only after a real browser passes its challenge.
This script reads cookies from Chrome (CDP or cookie DB) and can refresh them
by loading Upwork in a debug-enabled Chrome window.

Usage:
  python refresh_upwork_cookies.py              # export (refresh if cf_clearance missing)
  python refresh_upwork_cookies.py --export-only
  python refresh_upwork_cookies.py --refresh    # always open Upwork and wait for clearance
  python refresh_upwork_cookies.py --update-workflow
  python refresh_upwork_cookies.py --serve      # HTTP server on :9876 for n8n

Prerequisites:
  pip install -r requirements-cookies.txt

For CDP (recommended): close Chrome, run start_chrome_debug.bat, sign in if needed.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

try:
    import requests
except ImportError:
    print("Run: pip install -r c:\\n8n\\requirements-cookies.txt")
    sys.exit(1)

try:
    import websocket
except ImportError:
    websocket = None  # type: ignore

CDP_PORT = int(os.environ.get("UPWORK_CDP_PORT", "9222"))
CDP_BASE = f"http://127.0.0.1:{CDP_PORT}"
DATA_DIR = Path(os.environ.get("N8N_USER_FOLDER", r"C:\n8n\data"))
COOKIE_JSON = DATA_DIR / "upwork_cookies.json"
COOKIE_TXT = DATA_DIR / "upwork_cookies.txt"
WORKFLOW_PATH = Path(
    os.environ.get(
        "UPWORK_WORKFLOW_PATH",
        r"d:\Downloads\Upwork Job Bidding Automation (1).json",
    )
)
JOBS_URL = (
    "https://www.upwork.com/nx/s/universal-search/jobs/"
    "?category2_uid=531770282580668418&client_hires=1-9&from_recent_search=true"
    "&per_page=50&q=%28website%20AND%20web%20AND%20app%29%20AND%20NOT%20"
    "%28wordpress%20OR%20woocommerce%20OR%20shopify%29&sort=recency"
)
CHROME_PATHS = [
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
]
# Separate profile so automation works while your normal Chrome is open
AUTOMATION_PROFILE = Path(
    os.environ.get("UPWORK_CHROME_PROFILE", r"C:\n8n\chrome-profile")
)
SESSION_KEYS = ("master_access_token", "oauth2_global_js_token", "visitor_id")
PRIORITY_KEYS = (
    "cf_clearance",
    "cf_bm",
    "__cf_bm",
    "XSRF-TOKEN",
    "visitor_id",
    "master_access_token",
    "oauth2_global_js_token",
)


def find_chrome() -> Path | None:
    for path in CHROME_PATHS:
        if path.exists():
            return path
    try:
        out = subprocess.run(["where", "chrome"], capture_output=True, text=True, check=False)
        if out.returncode == 0 and out.stdout.strip():
            return Path(out.stdout.strip().splitlines()[0])
    except Exception:
        pass
    return None


def cdp_alive() -> bool:
    try:
        return requests.get(f"{CDP_BASE}/json/version", timeout=2).status_code == 200
    except Exception:
        return False


def launch_chrome_debug() -> None:
    chrome = find_chrome()
    if not chrome:
        print("Chrome not found. Install Chrome or set CHROME_EXE.")
        sys.exit(1)

    AUTOMATION_PROFILE.mkdir(parents=True, exist_ok=True)
    print(f"Launching Chrome with remote debugging on port {CDP_PORT}...")
    print(f"Profile: {AUTOMATION_PROFILE}")
    print("(First run: log into Upwork in that window. Your normal Chrome can stay open.)\n")

    subprocess.Popen(
        [
            str(chrome),
            f"--remote-debugging-port={CDP_PORT}",
            "--remote-allow-origins=*",
            f"--user-data-dir={AUTOMATION_PROFILE}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            JOBS_URL,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    for i in range(30):
        time.sleep(1)
        if cdp_alive():
            print("Chrome debug port ready.\n")
            return
    print("Timed out waiting for Chrome debug port.")
    sys.exit(1)


def _cdp_targets() -> list[dict]:
    r = requests.get(f"{CDP_BASE}/json", timeout=5)
    r.raise_for_status()
    return r.json()


def _pick_page_target(targets: list[dict]) -> dict | None:
    for t in targets:
        if t.get("type") == "page" and "upwork.com" in (t.get("url") or ""):
            return t
    for t in targets:
        if t.get("type") == "page":
            return t
    return None


class CdpSession:
    def __init__(self, ws_url: str) -> None:
        if websocket is None:
            raise RuntimeError("websocket-client not installed")
        self.ws = websocket.create_connection(ws_url, timeout=30)
        self._id = 0

    def close(self) -> None:
        try:
            self.ws.close()
        except Exception:
            pass

    def call(self, method: str, params: dict | None = None, timeout: float = 30) -> dict:
        self._id += 1
        msg_id = self._id
        payload: dict = {"id": msg_id, "method": method}
        if params:
            payload["params"] = params
        self.ws.send(json.dumps(payload))
        deadline = time.time() + timeout
        while time.time() < deadline:
            raw = self.ws.recv()
            msg = json.loads(raw)
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})
        raise TimeoutError(f"CDP timeout: {method}")

    def enable_domains(self) -> None:
        for domain in ("Network", "Page"):
            try:
                self.call(f"{domain}.enable", timeout=5)
            except Exception:
                pass


def cookies_from_cdp() -> dict[str, str]:
    targets = _cdp_targets()
    target = _pick_page_target(targets)
    if not target:
        return {}

    session = CdpSession(target["webSocketDebuggerUrl"])
    try:
        session.enable_domains()
        result = session.call("Network.getAllCookies", timeout=15)
        all_cookies = result.get("cookies", [])
        upwork = [c for c in all_cookies if "upwork.com" in c.get("domain", "")]
        return {c["name"]: c["value"] for c in upwork}
    finally:
        session.close()


def cookies_from_chrome_db() -> dict[str, str]:
    try:
        import browser_cookie3
    except ImportError:
        return {}

    cookies: dict[str, str] = {}
    try:
        for c in browser_cookie3.chrome(domain_name="upwork.com"):
            cookies[c.name] = c.value
    except Exception as exc:
        print(f"Could not read Chrome cookie DB: {exc}")
    return cookies


def build_cookie_string(cookies: dict[str, str]) -> str:
    ordered: dict[str, str] = {k: cookies[k] for k in PRIORITY_KEYS if k in cookies}
    ordered.update({k: v for k, v in cookies.items() if k not in ordered})
    return "; ".join(f"{k}={v}" for k, v in ordered.items())


def page_looks_blocked(html: str) -> bool:
    markers = (
        "Challenge - Upwork",
        "cf-browser-verification",
        "Enable JavaScript and cookies",
        "Just a moment",
        "Checking your browser",
    )
    return any(m in html for m in markers)


def _cdp_get_html(session: CdpSession) -> tuple[str, str]:
    eval_result = session.call(
        "Runtime.evaluate",
        {
            "expression": (
                "({ title: document.title, html: document.documentElement.outerHTML, "
                "jobs: document.querySelectorAll('[data-ev-job-uid], [data-test*=job-tile]').length })"
            ),
            "returnByValue": True,
        },
        timeout=20,
    )
    value = eval_result.get("result", {}).get("value") or {}
    return value.get("html") or "", value.get("title") or ""


def fetch_html_via_cdp(url: str, wait_seconds: int = 60) -> tuple[str, dict[str, str]]:
    """Fetch page HTML inside the automation Chrome (same session as cf_clearance)."""
    if not cdp_alive():
        launch_chrome_debug()
        time.sleep(2)

    targets = _cdp_targets()
    target = _pick_page_target(targets)
    if not target:
        return "", {}

    session = CdpSession(target["webSocketDebuggerUrl"])
    cookies: dict[str, str] = {}
    try:
        session.enable_domains()
        session.call("Page.navigate", {"url": url}, timeout=30)
        html = ""
        deadline = time.time() + wait_seconds
        while time.time() < deadline:
            time.sleep(2)
            cookies = cookies_from_cdp() or cookies
            html, title = _cdp_get_html(session)
            if page_looks_blocked(html):
                continue
            has_jobs = "data-ev-job-uid" in html or "job-tile-title-link" in html
            if has_jobs:
                break
            # Nuxt client-render: wait for job tiles to mount
            session.call(
                "Runtime.evaluate",
                {
                    "expression": (
                        "new Promise((resolve) => {"
                        "  const t0 = Date.now();"
                        "  const tick = () => {"
                        "    const n = document.querySelectorAll('[data-ev-job-uid]').length;"
                        "    if (n > 0 || Date.now() - t0 > 8000) resolve(n);"
                        "    else setTimeout(tick, 400);"
                        "  };"
                        "  tick();"
                        "})"
                    ),
                    "awaitPromise": True,
                },
                timeout=12,
            )
            html, _ = _cdp_get_html(session)
            if "data-ev-job-uid" in html:
                break
        return html, cookies
    finally:
        session.close()


def html_has_jobs(html: str) -> bool:
    return bool(
        html
        and not page_looks_blocked(html)
        and ("data-ev-job-uid" in html or "job-tile-title-link" in html)
    )


def refresh_clearance_via_cdp(wait_seconds: int = 120) -> dict[str, str]:
    if not cdp_alive():
        launch_chrome_debug()
        time.sleep(2)

    targets = _cdp_targets()
    target = _pick_page_target(targets)
    if not target:
        print("No Chrome page target for CDP refresh.")
        return {}

    session = CdpSession(target["webSocketDebuggerUrl"])
    try:
        session.enable_domains()
        print(f"Navigating to Upwork jobs page (up to {wait_seconds}s for Cloudflare)...")
        session.call("Page.navigate", {"url": JOBS_URL}, timeout=30)

        deadline = time.time() + wait_seconds
        last_cookies: dict[str, str] = {}

        while time.time() < deadline:
            time.sleep(2)
            cookies = cookies_from_cdp()
            if cookies:
                last_cookies = cookies

            if "cf_clearance" in cookies:
                try:
                    eval_result = session.call(
                        "Runtime.evaluate",
                        {"expression": "document.documentElement.outerHTML.slice(0, 8000)"},
                        timeout=10,
                    )
                    html = eval_result.get("result", {}).get("value") or ""
                    if html and not page_looks_blocked(html):
                        print("cf_clearance obtained and jobs page loaded.")
                        return cookies
                except Exception:
                    print("cf_clearance present in cookies.")
                    return cookies

            try:
                eval_result = session.call(
                    "Runtime.evaluate",
                    {"expression": "document.title + '|' + location.href"},
                    timeout=8,
                )
                status = eval_result.get("result", {}).get("value", "")
                print(f"  waiting... {status[:120]}")
            except Exception:
                print("  waiting for Cloudflare...")

        print("Timed out waiting for cf_clearance. Complete any challenge in the Chrome window.")
        return last_cookies
    finally:
        session.close()


def save_cookies(cookies: dict[str, str]) -> str:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cookie_string = build_cookie_string(cookies)
    payload = {
        "cookieString": cookie_string,
        "cookies": cookies,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "hasCfClearance": "cf_clearance" in cookies,
        "hasSession": any(k in cookies for k in SESSION_KEYS),
    }
    COOKIE_JSON.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    COOKIE_TXT.write_text(cookie_string, encoding="utf-8")
    return cookie_string


def update_workflow(cookie_string: str) -> int:
    if not WORKFLOW_PATH.exists():
        print(f"Workflow not found: {WORKFLOW_PATH}")
        return 0

    workflow = json.loads(WORKFLOW_PATH.read_text(encoding="utf-8"))
    updated = 0
    for node in workflow.get("nodes", []):
        for header in node.get("parameters", {}).get("headerParameters", {}).get("parameters", []):
            if header.get("name", "").lower() == "cookie":
                header["value"] = cookie_string
                updated += 1
    WORKFLOW_PATH.write_text(json.dumps(workflow, indent=2), encoding="utf-8")
    return updated


def collect_cookies(force_refresh: bool, refresh_if_missing: bool = True) -> dict[str, str]:
    cookies: dict[str, str] = {}

    if cdp_alive():
        print("Reading cookies via Chrome DevTools (CDP)...")
        cookies = cookies_from_cdp()

    if not cookies:
        print("Trying Chrome cookie database (browser_cookie3)...")
        cookies = cookies_from_chrome_db()

    need_refresh = force_refresh or (refresh_if_missing and "cf_clearance" not in cookies)
    if need_refresh:
        print("cf_clearance missing or refresh requested.")
        if not cdp_alive():
            launch_chrome_debug()
            time.sleep(2)
        refreshed = refresh_clearance_via_cdp()
        if refreshed:
            cookies = refreshed
        elif cdp_alive():
            cookies = cookies_from_cdp() or cookies

    return cookies


def print_status(cookies: dict[str, str]) -> None:
    if not cookies:
        print("No Upwork cookies found.")
        return
    print(f"Cookies ({len(cookies)}): {', '.join(sorted(cookies.keys()))}")
    if "cf_clearance" not in cookies:
        print("WARNING: cf_clearance still missing — n8n HTTP requests will likely be blocked.")
    if not any(k in cookies for k in SESSION_KEYS):
        print("WARNING: no Upwork session token — log in to Upwork in Chrome.")


def run_serve() -> None:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path not in ("/", "/cookies"):
                self.send_error(404)
                return
            cookies = collect_cookies(force_refresh=False)
            body = {
                "cookieString": build_cookie_string(cookies),
                "hasCfClearance": "cf_clearance" in cookies,
                "cookieCount": len(cookies),
            }
            data = json.dumps(body).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, fmt: str, *args) -> None:
            print(f"[cookie-server] {fmt % args}")

    print(f"Cookie server listening on http://127.0.0.1:9876/cookies")
    HTTPServer(("127.0.0.1", 9876), Handler).serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh Upwork cf_clearance cookies for n8n")
    parser.add_argument("--export-only", action="store_true", help="Do not navigate/wait for refresh")
    parser.add_argument("--refresh", action="store_true", help="Always load Upwork and wait for cf_clearance")
    parser.add_argument("--update-workflow", action="store_true", help="Also patch workflow JSON cookie headers")
    parser.add_argument("--serve", action="store_true", help="Run HTTP server for n8n (port 9876)")
    args = parser.parse_args()

    if args.serve:
        run_serve()
        return

    force_refresh = bool(args.refresh)
    refresh_if_missing = not args.export_only

    cookies = collect_cookies(
        force_refresh=force_refresh,
        refresh_if_missing=refresh_if_missing,
    )
    print_status(cookies)

    if not cookies:
        print("\nNext steps:")
        print("  1. Close all Chrome windows")
        print("  2. Run start_chrome_debug.bat")
        print("  3. Log into Upwork and pass any Cloudflare check")
        print("  4. Run this script again")
        sys.exit(1)

    cookie_string = save_cookies(cookies)
    print(f"\nSaved to:\n  {COOKIE_JSON}\n  {COOKIE_TXT}")

    if args.update_workflow:
        n = update_workflow(cookie_string)
        print(f"Updated {n} cookie header(s) in workflow JSON.")

    print("\nIn n8n, set the Cookie header to:")
    print("  {{ $('Load Upwork Cookies').first().json.cookieString }}")


if __name__ == "__main__":
    main()
