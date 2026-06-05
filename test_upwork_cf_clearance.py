"""
End-to-end test: obtain cf_clearance and verify Upwork jobs page loads.
Run: python c:\n8n\test_upwork_cf_clearance.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import requests

# Reuse refresh module logic
sys.path.insert(0, str(Path(__file__).parent))
import refresh_upwork_cookies as ruc

JOBS_URL = ruc.JOBS_URL
DATA_DIR = ruc.DATA_DIR
COOKIE_JSON = ruc.COOKIE_JSON
AUTOMATION_PROFILE = Path(r"C:\n8n\chrome-profile")
CDP_PORT = ruc.CDP_PORT


def launch_automation_chrome() -> None:
    chrome = ruc.find_chrome()
    if not chrome:
        raise RuntimeError("Chrome not found")

    AUTOMATION_PROFILE.mkdir(parents=True, exist_ok=True)
    print(f"Launching Chrome (automation profile, port {CDP_PORT})...")
    print("If this is the first run, log into Upwork in the window that opens.\n")

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

    for _ in range(45):
        time.sleep(1)
        if ruc.cdp_alive():
            print("CDP ready.\n")
            return
    raise RuntimeError("Chrome debug port did not start within 45s")


def test_http_with_cookies(cookie_string: str) -> dict:
    headers = {
        "user-agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "cookie": cookie_string,
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
    }
    r = requests.get(JOBS_URL, headers=headers, timeout=30, allow_redirects=True)
    html = r.text
    blocked = ruc.page_looks_blocked(html)
    has_jobs = "data-ev-job-uid" in html or "job-tile-title-link" in html
    return {
        "method": "requests",
        "status": r.status_code,
        "length": len(html),
        "blocked": blocked,
        "has_jobs": has_jobs,
        "title_snippet": html[:300].replace("\n", " "),
    }


def test_curl_cffi(cookie_string: str) -> dict:
    try:
        from curl_cffi import requests as cr
    except ImportError:
        return {"method": "curl_cffi", "error": "not installed", "blocked": True, "has_jobs": False}

    r = cr.get(
        JOBS_URL,
        headers={"cookie": cookie_string, "accept-language": "en-US,en;q=0.9"},
        impersonate="chrome131",
        timeout=30,
    )
    html = r.text
    blocked = ruc.page_looks_blocked(html)
    has_jobs = "data-ev-job-uid" in html or "job-tile-title-link" in html
    return {
        "method": "curl_cffi",
        "status": r.status_code,
        "length": len(html),
        "blocked": blocked,
        "has_jobs": has_jobs,
    }


def test_playwright_fetch() -> dict:
    from playwright.sync_api import sync_playwright

    PROFILE = Path(r"C:\n8n\chrome-profile")
    PROFILE.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE),
            channel="chrome",
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(JOBS_URL, wait_until="domcontentloaded", timeout=60000)
        for _ in range(45):
            time.sleep(1)
            html = page.content()
            if not ruc.page_looks_blocked(html) and (
                "data-ev-job-uid" in html or "job-tile-title-link" in html
            ):
                cookies = {c["name"]: c["value"] for c in ctx.cookies() if "upwork" in c.get("domain", "")}
                if cookies:
                    ruc.save_cookies(cookies)
                ctx.close()
                return {
                    "method": "playwright",
                    "blocked": False,
                    "has_jobs": True,
                    "length": len(html),
                }
        html = page.content()
        cookies = {c["name"]: c["value"] for c in ctx.cookies() if "upwork" in c.get("domain", "")}
        if cookies:
            ruc.save_cookies(cookies)
        ctx.close()
        return {
            "method": "playwright",
            "blocked": ruc.page_looks_blocked(html),
            "has_jobs": "data-ev-job-uid" in html,
            "length": len(html),
        }


def try_playwright_refresh() -> dict[str, str]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright not installed, skipping.")
        return {}

    AUTOMATION_PROFILE.mkdir(parents=True, exist_ok=True)
    print("Trying Playwright (headed Chrome)...")
    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(
            user_data_dir=str(AUTOMATION_PROFILE),
            channel="chrome",
            headless=False,
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = browser.pages[0] if browser.pages else browser.new_page()
        page.goto(JOBS_URL, wait_until="domcontentloaded", timeout=60000)

        for i in range(60):
            time.sleep(2)
            cookies = {c["name"]: c["value"] for c in browser.cookies() if "upwork" in c.get("domain", "")}
            content = page.content()
            if "cf_clearance" in cookies and not ruc.page_looks_blocked(content):
                print(f"Playwright OK after {(i + 1) * 2}s")
                browser.close()
                return cookies
            if i % 5 == 0:
                print(f"  playwright wait {(i + 1) * 2}s, cf_clearance={('cf_clearance' in cookies)}")

        cookies = {c["name"]: c["value"] for c in browser.cookies() if "upwork" in c.get("domain", "")}
        browser.close()
        return cookies


def main() -> int:
    print("=" * 60)
    print("Upwork cf_clearance test")
    print("=" * 60)

    cookies: dict[str, str] = {}

    # 1) CDP if already running
    if ruc.cdp_alive():
        print("[1] CDP already running — reading cookies...")
        cookies = ruc.cookies_from_cdp()

    # 2) Launch dedicated automation Chrome (no conflict with daily Chrome)
    if not cookies.get("cf_clearance"):
        print("[2] Starting automation Chrome profile...")
        if not ruc.cdp_alive():
            launch_automation_chrome()
            time.sleep(3)
        cookies = ruc.refresh_clearance_via_cdp(wait_seconds=90) or ruc.cookies_from_cdp()

    # 3) Playwright fallback
    if not cookies.get("cf_clearance"):
        print("[3] CDP did not get cf_clearance — Playwright fallback...")
        cookies = try_playwright_refresh()

    if not cookies:
        print("\nFAIL: No Upwork cookies obtained.")
        return 1

    print(f"\nCookies: {', '.join(sorted(cookies.keys()))}")
    if "cf_clearance" not in cookies:
        print("FAIL: cf_clearance still missing after all methods.")
        return 1

    cookie_string = ruc.build_cookie_string(cookies)
    ruc.save_cookies(cookies)
    print(f"Saved {COOKIE_JSON}")

    print("\n[4] HTTP tests...")
    req_result = test_http_with_cookies(cookie_string)
    print(f"  requests: blocked={req_result['blocked']} jobs={req_result.get('has_jobs')}")

    cffi_result = test_curl_cffi(cookie_string)
    print(f"  curl_cffi: blocked={cffi_result['blocked']} jobs={cffi_result.get('has_jobs')}")

    if not req_result["blocked"] and req_result.get("has_jobs"):
        print("\nPASS: plain HTTP works with cookies.")
        return 0

    print("\n[5] CDP browser fetch (same Chrome session — reliable path)...")
    html, _ = ruc.fetch_html_via_cdp(JOBS_URL, wait_seconds=45)
    cdp_blocked = ruc.page_looks_blocked(html) if html else True
    cdp_jobs = ruc.html_has_jobs(html)
    print(f"  cdp_fetch: blocked={cdp_blocked} jobs={cdp_jobs} len={len(html)}")

    if cdp_jobs and not cdp_blocked:
        print("\nPASS: CDP fetch works. Run upwork_fetch_service.py for n8n.")
        return 0

    print("\nFAIL: Could not fetch jobs. Log into Upwork in the automation Chrome window.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
