"""Canonical oracle: no reformatting, screening, or hand-written expected output.

The companion JSON records the original enhanced DOM input so offline tests
compare serializers on the SAME capture, not two drifting live documents.
--check reports live drift as STALE FIXTURES; it never updates the oracle.
"""
import argparse
import asyncio
import hashlib
import json
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

from browser_use import BrowserSession
from browser_use.dom.service import DomService

PIN = "0.13.10"
URLS = {
    "ipinfo": "https://ipinfo.io/developers",
    "stripe": "https://docs.stripe.com/api",
    "hacker-news": "https://news.ycombinator.com",
    "wikipedia": "https://en.wikipedia.org/wiki/Certificate_authority",
    "github": "https://github.com/anthropics",
    "gov-uk": "https://www.gov.uk/browse/benefits",
}
ROOT = Path(__file__).resolve().parents[1]


def capture_node(node):
    """Only capture inputs / view properties, never serializer decisions."""
    snap = node.snapshot_node
    return {
        "id": str(node.backend_node_id),
        "nodeType": int(node.node_type),
        "nodeName": node.node_name,
        "value": node.node_value,
        "attributes": node.attributes,
        "visible": bool(node.is_visible),
        "snapshot": snap is not None,
        "bounds": snap.bounds.to_dict() if snap and snap.bounds else None,
        "cursor": snap.cursor_style if snap else None,
        "scrollable": bool(node.is_actually_scrollable),
        "showScroll": node.should_show_scroll_info,
        "scrollText": node.get_scroll_info_text(),
        "clickListener": node.has_js_click_listener,
        "axRole": node.ax_node.role if node.ax_node else None,
        "axProperties": [{"name": p.name, "value": p.value} for p in node.ax_node.properties or []] if node.ax_node else [],
        "axChildIds": node.ax_node.child_ids if node.ax_node else [],
        "shadowType": node.shadow_root_type,
        "hiddenElements": [{**item, "pages": str(item["pages"])} for item in node.hidden_elements_info],
        "hiddenContent": node.has_hidden_content,
        "children": [capture_node(c) for c in node.children_and_shadow_roots],
        "contentDocument": capture_node(node.content_document) if node.content_document else None,
    }


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--slug", choices=URLS)
    args = parser.parse_args()
    assert version("browser-use") == PIN
    output = ROOT / "fixtures/browser-use"
    output.mkdir(parents=True, exist_ok=True)
    browser = BrowserSession(
        headless=True, executable_path="/usr/bin/google-chrome",
        user_data_dir=str(ROOT / ".local/browser-use/profile"),
        viewport={"width": 1280, "height": 800},
        enable_default_extensions=False,
        args=["--no-sandbox"],
    )
    stale = []
    try:
        await asyncio.wait_for(browser.start(), timeout=45)
        for slug, url in URLS.items():
            if args.slug and slug != args.slug:
                continue
            await browser.navigate_to(url)
            await asyncio.sleep(3)
            # Paint order is the binding review's named follow-up. Viewport
            # threshold 0 scopes the canonical capture to the actual viewport.
            service = DomService(browser, viewport_threshold=0, paint_order_filtering=False, cross_origin_iframes=True)
            state, tree, _ = await service.get_serialized_dom_tree()
            actual = state.llm_representation()
            target = output / f"{slug}.txt"
            if args.check:
                import re
                identity = lambda s: re.sub(r"(?m)(\*?\[)\d+(\]<)", r"\1ID\2", s)
                if not target.exists() or identity(target.read_text()) != identity(actual):
                    stale.append(slug)
                continue
            target.write_bytes(actual.encode("utf-8"))
            payload = {
                "browserUse": PIN, "capturedAt": datetime.now(timezone.utc).isoformat(),
                "url": url, "viewport": {"width": 1280, "height": 800},
                "paintOrderFiltering": False, "viewportThreshold": 0, "crossOriginIframes": True,
                "sha256": hashlib.sha256(actual.encode()).hexdigest(),
                "root": capture_node(tree),
            }
            (output / f"{slug}.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
            print(f"CAPTURED {slug}: {len(actual.encode())} bytes", flush=True)
    finally:
        await browser.kill()
    if stale:
        raise SystemExit("STALE FIXTURES: " + ", ".join(stale))


asyncio.run(main())
