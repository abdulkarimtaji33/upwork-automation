"""Quick test of the local fetch service."""
import re
import sys
import time

import requests

BASE = "http://127.0.0.1:9877"


def main() -> int:
    for _ in range(3):
        try:
            h = requests.get(f"{BASE}/health", timeout=3)
            if h.status_code == 200:
                break
        except Exception:
            pass
        print("Waiting for fetch service...")
        time.sleep(2)
    else:
        print("FAIL: start upwork_fetch_service.py first")
        return 1

    r = requests.get(f"{BASE}/fetch/jobs", timeout=120)
    html = r.text
    jobs = len(re.findall(r'data-ev-job-uid="(\d+)"', html))
    blocked = "Challenge - Upwork" in html
    print(f"status={r.status_code} len={len(html)} jobs={jobs} blocked={blocked}")
    return 0 if jobs > 0 and not blocked else 1


if __name__ == "__main__":
    sys.exit(main())
