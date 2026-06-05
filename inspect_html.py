import re
import refresh_upwork_cookies as r

html, _ = r.fetch_html_via_cdp(r.JOBS_URL, wait_seconds=30)
print("len", len(html))
print("blocked", r.page_looks_blocked(html))
for m in ["data-ev-job-uid", "job-tile-title-link", "job-tile", "universal-search", "Challenge - Upwork"]:
    print(m, html.count(m))
if "<title" in html:
    i = html.find("<title")
    print("title:", html[i : i + 100])
# run workflow parser logic
article_pattern = re.compile(r'data-ev-job-uid="(\d+)"')
print("article uids", len(article_pattern.findall(html)))
