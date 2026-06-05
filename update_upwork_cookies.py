"""
Reads Upwork cookies from Chrome via CDP and updates the n8n workflow JSON.
Run: python update_upwork_cookies.py
"""

import json
import os
import sys
import time
import subprocess
import websocket
from pathlib import Path

try:
    import requests
except ImportError:
    print("Missing: pip install requests websocket-client")
    sys.exit(1)

WORKFLOW_PATH = r"d:\Downloads\Upwork Job Bidding Automation (1).json"
CDP_PORT = 9222
CHROME_EXE = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
CHROME_EXE_X86 = r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"


def find_chrome():
    for path in [CHROME_EXE, CHROME_EXE_X86]:
        if os.path.exists(path):
            return path
    result = subprocess.run(
        ["where", "chrome"], capture_output=True, text=True
    )
    if result.returncode == 0:
        return result.stdout.strip().splitlines()[0]
    return None


def check_cdp():
    try:
        r = requests.get(f"http://localhost:{CDP_PORT}/json/version", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def launch_chrome_with_debug():
    chrome = find_chrome()
    if not chrome:
        print("Chrome not found. Install Chrome or set CHROME_EXE path in this script.")
        sys.exit(1)

    print(f"Launching Chrome with --remote-debugging-port={CDP_PORT}...")
    print("(A new Chrome window will open. Sign into Upwork if prompted.)\n")

    subprocess.Popen([
        chrome,
        f"--remote-debugging-port={CDP_PORT}",
        "--no-first-run",
        "--no-default-browser-check",
        "https://www.upwork.com",
    ])

    print("Waiting for Chrome to start", end="", flush=True)
    for _ in range(20):
        time.sleep(1)
        print(".", end="", flush=True)
        if check_cdp():
            print(" ready!\n")
            return
    print("\nChrome debug port not responding. Check that Chrome started correctly.")
    sys.exit(1)


def get_cookies_via_cdp():
    r = requests.get(f"http://localhost:{CDP_PORT}/json", timeout=5)
    targets = r.json()

    ws_url = None
    for t in targets:
        if t.get("type") == "page":
            ws_url = t["webSocketDebuggerUrl"]
            break

    if not ws_url:
        print("No Chrome page found to attach to.")
        sys.exit(1)

    ws = websocket.create_connection(ws_url, timeout=10)

    ws.send(json.dumps({"id": 1, "method": "Network.getAllCookies"}))

    for _ in range(30):
        msg = json.loads(ws.recv())
        if msg.get("id") == 1:
            ws.close()
            all_cookies = msg.get("result", {}).get("cookies", [])
            upwork = [c for c in all_cookies if "upwork.com" in c.get("domain", "")]
            return {c["name"]: c["value"] for c in upwork}

    ws.close()
    return {}


def build_cookie_string(cookies):
    priority = ["cf_clearance", "XSRF-TOKEN", "visitor_id", "master_access_token", "oauth2_global_js_token"]
    ordered = {k: cookies[k] for k in priority if k in cookies}
    ordered.update({k: v for k, v in cookies.items() if k not in ordered})
    return "; ".join(f"{k}={v}" for k, v in ordered.items())


def update_workflow(cookie_string):
    with open(WORKFLOW_PATH, "r", encoding="utf-8") as f:
        workflow = json.load(f)

    updated = 0
    for node in workflow["nodes"]:
        params = node.get("parameters", {})
        header_params = params.get("headerParameters", {}).get("parameters", [])
        for header in header_params:
            if header.get("name", "").lower() == "cookie":
                header["value"] = cookie_string
                updated += 1

    with open(WORKFLOW_PATH, "w", encoding="utf-8") as f:
        json.dump(workflow, f, indent=2, ensure_ascii=False)

    return updated


if __name__ == "__main__":
    if not check_cdp():
        print(f"Chrome debug port {CDP_PORT} not detected — launching Chrome with debug port...")
        launch_chrome_with_debug()
        time.sleep(3)

    print("Connecting to Chrome via CDP...")
    cookies = get_cookies_via_cdp()

    if not cookies:
        print("No Upwork cookies found. Make sure you are logged into Upwork in Chrome.")
        sys.exit(1)

    print(f"Found {len(cookies)} cookies: {', '.join(cookies.keys())}")

    has_clearance = "cf_clearance" in cookies
    has_session   = any(k in cookies for k in ["master_access_token", "oauth2_global_js_token", "visitor_id"])

    if not has_clearance:
        print("WARNING: cf_clearance not found — Cloudflare may block requests.")
    if not has_session:
        print("WARNING: No Upwork session token found — you may not be logged in.")

    cookie_string = build_cookie_string(cookies)
    nodes_updated = update_workflow(cookie_string)

    print(f"\nUpdated {nodes_updated} cookie header(s) in:\n  {WORKFLOW_PATH}")
    print("\nDone. Re-import the workflow JSON into n8n.")
