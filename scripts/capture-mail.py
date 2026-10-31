"""Screenshots Mailpit messages (local, synthetic data) to PNG, for documentation.

Usage: python -I -X utf8 scripts/capture-mail.py <out_dir> <message_id> <file_name> [<message_id> <file_name> ...]
Message ids come from http://localhost:8025/api/v1/messages. Read-only: nothing in Mailpit or n8n is changed.
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

if len(sys.argv) < 4 or len(sys.argv) % 2 != 0:
    raise SystemExit(__doc__)
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
pairs = list(zip(sys.argv[2::2], sys.argv[3::2]))
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1100, "height": 760}, color_scheme="dark")
    for message_id, name in pairs:
        page.goto(f"http://localhost:8025/view/{message_id}")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(out / name))
        print("saved", out / name, flush=True)
    browser.close()
