"""Compresses n8n editor screenshots (PNG) to light JPGs for the catalog site.

Usage: python -I -X utf8 scripts/compress-shots.py <manifest.json>
The manifest is a JSON list of {"src": ..., "dst": ..., "width": 1600, "quality": 72}. Read-only on the sources.
"""
import json
import sys
from pathlib import Path

from PIL import Image

if len(sys.argv) != 2:
    raise SystemExit(__doc__)
items = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
total_in = total_out = 0
for it in items:
    src, dst = Path(it["src"]), Path(it["dst"])
    im = Image.open(src).convert("RGB")
    w = min(it.get("width", 1600), im.width)
    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, "JPEG", quality=it.get("quality", 72), optimize=True, progressive=True)
    total_in += src.stat().st_size
    total_out += dst.stat().st_size
print(f"compressed {len(items)} images: {total_in / 1e6:.1f} MB -> {total_out / 1e6:.1f} MB", flush=True)
