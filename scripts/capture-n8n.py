"""Captures REAL screenshots of the n8n editor (not diagrams) with Playwright.

Usage:
  python scripts/capture-n8n.py login      # opens a visible browser; you sign in to n8n once (session is kept in a local profile)
  python scripts/capture-n8n.py capture    # canvas tiles + latest execution of every workflow -> docs/screenshots/n8n/

Nothing here edits a workflow: the canvas is panned/zoomed by changing the CSS transform of the viewport only,
so the saved workflow (positions included) is never touched. Credentials are never read or stored by this script.
"""
import json
import math
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "screenshots" / "n8n"
PROFILE = Path.home() / ".n8n-capture-profile"
BASE = "http://localhost:5678"
VIEWPORT = {"width": 1920, "height": 1080}

# (slug, id, repo json, max tiles)
WORKFLOWS = [
    ("01-lead-intake", "leadintake000001", "lead-intake.json", 5),
    ("02-weekly-report", "weeklyreport0001", "weekly-report.json", 3),
    ("03-revival-daily-run", "revivalrun000001", "revival-run.json", 4),
    ("04-revival-send-touch", "revivaltouch0001", "revival-touch.json", 4),
    ("05-revival-handle-reply", "revivalreply0001", "revival-reply.json", 5),
    ("06-error-handler", "errhandler000001", "error-handler.json", 1),
    ("07-revival-prepare-draft", "revivalprepare01", "revival-prepare.json", 4),
    ("08-revival-review-page", "revivalreview001", "revival-review.json", 3),
    ("09-revival-send-queue", "revivalqueue0001", "revival-queue.json", 1),
    ("10-revival-dashboard", "revivaldash00001", "revival-dashboard.json", 1),
    ("11-qualifier-inbound", "qualifierinbound1", "qualifier-inbound.json", 5),
    ("12-qualifier-booking", "qualifierbooking1", "qualifier-booking.json", 5),
    ("13-qualifier-send", "qualifiersend001", "qualifier-send.json", 3),
    ("14-qualifier-stale-queue", "qualifierstale01", "qualifier-stale.json", 2),
    ("15-support-kb-ingest", "supportkbingest1", "support-kb-ingest.json", 2),
    ("16-support-ticket-agent", "supportticket001", "support-ticket.json", 5),
    ("17-sync-run", "syncrun00000001", "sync-run.json", 4),
    ("18-sync-conflict-review", "syncreview000001", "sync-review.json", 3),
    ("19-sync-weekly-summary", "syncweekly00001", "sync-weekly.json", 1),
    ("20-invoice-processor", "invoiceintake0001", "invoice-intake.json", 5),
    ("21-triage-ticket-intake", "triageintake0001", "triage-intake.json", 5),
    ("22-triage-sla-watcher", "triageslawatch01", "triage-sla-watch.json", 3),
    ("23-triage-ticket-update", "triageupdate0001", "triage-update.json", 3),
    ("24-reminders-send", "remindersend0001", "reminders-send.json", 3),
    ("25-reminders-customer-reply", "reminderreply001", "reminders-reply.json", 5),
    ("26-reminders-noshow-sweep", "remindernoshow01", "reminders-noshow.json", 3),
    ("27-reminders-staff-update", "reminderstaff0001", "reminders-staff.json", 3),
]


def context(p, headless):
    return p.chromium.launch_persistent_context(
        str(PROFILE), headless=headless, viewport=VIEWPORT, device_scale_factor=1, color_scheme="dark"
    )


def login():
    with sync_playwright() as p:
        ctx = context(p, headless=False)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(f"{BASE}/signin")
        print("Sign in to n8n in the browser window that just opened (waiting up to 10 min)...", flush=True)
        page.wait_for_function("!location.pathname.startsWith('/signin')", timeout=600_000)
        page.wait_for_timeout(1500)
        print("Logged in. Session saved in", PROFILE, flush=True)
        ctx.close()


def tidy_ui(page):
    """Hide the 'Production Checklist' card so it never covers the canvas. UI-only; does not touch the workflow."""
    page.wait_for_timeout(1200)
    hidden = page.evaluate("""() => {
        const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim().startsWith('Production Checklist') && e.children.length < 4);
        if (!el) return false;
        let n = el;
        while (n && n !== document.body) {
            const pos = getComputedStyle(n).position;
            if (pos === 'absolute' || pos === 'fixed') { n.style.display = 'none'; return true; }
            n = n.parentElement;
        }
        el.closest('div').style.display = 'none';
        return true;
    }""")
    print("  checklist card hidden" if hidden else "  (no checklist card)", flush=True)


def node_bbox(workflow):
    xs0, ys0, xs1, ys1 = [], [], [], []
    for n in workflow["nodes"]:
        x, y = n["position"]
        if n["type"].endswith("stickyNote"):
            w, h = n["parameters"].get("width", 150), n["parameters"].get("height", 80)
        else:
            w, h = 100, 130  # icon + label underneath
        xs0.append(x); ys0.append(y); xs1.append(x + w); ys1.append(y + h)
    return min(xs0), min(ys0), max(xs1), max(ys1)


def set_view(page, scale, tx, ty):
    return page.evaluate(
        """([s, tx, ty]) => {
            const pane = document.querySelector('.vue-flow__transformationpane');
            if (!pane) return false;
            pane.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
            return true;
        }""",
        [scale, tx, ty],
    )


def tile_canvas(page, wf, folder, prefix, max_tiles, slug):
    x0, y0, x1, y1 = node_bbox(wf)
    box = page.evaluate("""() => { const r = document.querySelector('.vue-flow').getBoundingClientRect();
                                   return {x: r.x, y: r.y, w: r.width, h: r.height}; }""")
    W, H = x1 - x0, y1 - y0
    pad = 60
    scale = min((box["h"] - 2 * pad) / H, 1.1)
    tile_w = (box["w"] - 2 * pad) / scale            # canvas units visible per tile
    tiles = max(1, min(max_tiles, math.ceil(W / (tile_w * 0.92))))
    if W > tile_w * 0.92 * tiles:                    # not enough tiles at this zoom: shrink so everything is covered
        scale = (box["w"] - 2 * pad) / (W / tiles / 0.92)
        tile_w = (box["w"] - 2 * pad) / scale
    step = 0 if tiles == 1 else (W - tile_w) / (tiles - 1)
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob(f"{prefix}-*.png"):
        old.unlink()
    for i in range(tiles):
        left = x0 + (W - tile_w) / 2 if tiles == 1 else x0 + step * i
        tx = box["x"] + pad - left * scale
        ty = box["y"] + pad - y0 * scale + (box["h"] - 2 * pad - H * scale) / 2
        if not set_view(page, scale, tx - box["x"], ty - box["y"]):
            raise RuntimeError("Vue Flow pane not found: n8n UI changed, update the selector")
        page.wait_for_timeout(400)
        path = folder / f"{prefix}-{i + 1}-of-{tiles}.png"
        page.screenshot(path=str(path))
        print(f"{slug}: {path.name} (scale {scale:.2f})", flush=True)


def capture_canvas(page, slug, wf_id, json_name, max_tiles):
    wf = json.loads((ROOT / "workflows" / json_name).read_text(encoding="utf-8"))
    page.goto(f"{BASE}/workflow/{wf_id}")
    page.wait_for_selector(".vue-flow__node", timeout=30_000)
    tidy_ui(page)
    tile_canvas(page, wf, OUT / slug, "canvas", max_tiles, slug)
    return wf


def capture_execution(page, slug, wf_id, wf, max_tiles):
    """Latest execution preview (nodes in green with the data that went through)."""
    page.goto(f"{BASE}/workflow/{wf_id}/executions")
    try:
        page.wait_for_selector('[data-test-id^="execution-details-"]', timeout=20_000)
        page.wait_for_selector(".vue-flow__node", timeout=20_000)
    except Exception:
        print(f"{slug}: no executions found (skipped; run the smoke tests first)", flush=True)
        return
    tidy_ui(page)
    page.wait_for_timeout(1500)
    tile_canvas(page, wf, OUT / slug, "execution", max_tiles, slug)


def capture():
    with sync_playwright() as p:
        ctx = context(p, headless=True)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(f"{BASE}/home/workflows")
        page.wait_for_timeout(1500)
        if "/signin" in page.url:
            raise SystemExit("Not logged in: run `python scripts/capture-n8n.py login` first.")
        only = sys.argv[2:]   # optional: slug prefixes, e.g. `capture 17 18 19`
        for slug, wf_id, json_name, tiles in [w for w in WORKFLOWS if not only or any(w[0].startswith(o) for o in only)]:
            wf = capture_canvas(page, slug, wf_id, json_name, tiles)
            capture_execution(page, slug, wf_id, wf, min(tiles, 3))
        ctx.close()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "login":
        login()
    elif cmd == "capture":
        capture()
    else:
        raise SystemExit(__doc__)
