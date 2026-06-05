"""
Paste the Cookie header from Chrome DevTools into your n8n workflow.

How to copy (while on an Upwork page in Chrome):
  1. F12 → Network tab → refresh the page
  2. Click any request to www.upwork.com
  3. Headers → Request Headers → right-click "cookie:" → Copy value
  4. Run: python c:\n8n\paste_cookie_header.py
  5. Paste when prompted, then press Enter twice
"""

import json
import os
import sys
from pathlib import Path

DATA_DIR = Path(os.environ.get("N8N_USER_FOLDER", r"C:\n8n\data"))
COOKIE_JSON = DATA_DIR / "upwork_cookies.json"
COOKIE_TXT = DATA_DIR / "upwork_cookies.txt"
WORKFLOW_PATH = Path(
    os.environ.get(
        "UPWORK_WORKFLOW_PATH",
        r"d:\Downloads\Upwork Job Bidding Automation (1).json",
    )
)


def main() -> None:
    print("Paste the full Cookie header value, then press Enter twice:\n")
    lines = []
    while True:
        line = input()
        if not line.strip():
            if lines:
                break
            continue
        lines.append(line.strip())
    cookie_string = " ".join(lines).strip()
    if cookie_string.lower().startswith("cookie:"):
        cookie_string = cookie_string.split(":", 1)[1].strip()

    if "cf_clearance" not in cookie_string:
        print("WARNING: cf_clearance not in pasted value — Cloudflare may still block.")
    if not cookie_string:
        print("Empty cookie string.")
        sys.exit(1)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cookies = {}
    for part in cookie_string.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            cookies[k.strip()] = v.strip()

    payload = {
        "cookieString": cookie_string,
        "cookies": cookies,
        "hasCfClearance": "cf_clearance" in cookies,
        "source": "manual-paste",
    }
    COOKIE_JSON.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    COOKIE_TXT.write_text(cookie_string, encoding="utf-8")
    print(f"\nSaved to {COOKIE_TXT}")

    if WORKFLOW_PATH.exists():
        workflow = json.loads(WORKFLOW_PATH.read_text(encoding="utf-8"))
        n = 0
        for node in workflow.get("nodes", []):
            for h in node.get("parameters", {}).get("headerParameters", {}).get("parameters", []):
                if h.get("name", "").lower() == "cookie":
                    h["value"] = cookie_string
                    n += 1
        WORKFLOW_PATH.write_text(json.dumps(workflow, indent=2), encoding="utf-8")
        print(f"Updated {n} cookie header(s) in workflow JSON.")
    print("Re-import the workflow in n8n if you use the JSON file.")


if __name__ == "__main__":
    main()
