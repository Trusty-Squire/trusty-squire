"""Canonical oracle: no reformatting, screening, or hand-written expected output.

The companion JSON records the original enhanced DOM input so offline tests
compare serializers on the SAME capture, not two drifting live documents.
--check reports live drift as STALE FIXTURES; it never updates the oracle.
"""
import argparse
import asyncio
import hashlib
import json
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

from browser_use import BrowserSession
from browser_use.dom.service import DomService

PIN = "0.13.10"
URLS = {
    "ipinfo": "https://ipinfo.io/developers",
    "mdn": "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
    "hacker-news": "https://news.ycombinator.com",
    "wikipedia": "https://en.wikipedia.org/wiki/Certificate_authority",
    "github": "https://github.com/anthropics",
    "gov-uk": "https://www.gov.uk/browse/benefits",
    "shopify": "local:shopify.html",
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
        "paintOrder": snap.paint_order if snap else None,
        "computedStyles": snap.computed_styles if snap else None,
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
    local_server = None
    if not args.slug or args.slug == "shopify":
        local_server = ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(ROOT / "fixtures/browser-use/pages")))
        threading.Thread(target=local_server.serve_forever, daemon=True).start()
    try:
        await asyncio.wait_for(browser.start(), timeout=45)
        for slug, url in URLS.items():
            if args.slug and slug != args.slug:
                continue
            navigation_url = f"http://127.0.0.1:{local_server.server_port}/{url.removeprefix('local:')}" if url.startswith("local:") else url
            await browser.navigate_to(navigation_url)
            await asyncio.sleep(3)
            # Keep canonical paint-order filtering enabled; record its snapshot inputs.
            service = DomService(browser, viewport_threshold=0, paint_order_filtering=True, cross_origin_iframes=True)
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
                "paintOrderFiltering": True, "viewportThreshold": 0, "crossOriginIframes": True,
                "sha256": hashlib.sha256(actual.encode()).hexdigest(),
                "root": capture_node(tree),
            }
            (output / f"{slug}.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
            print(f"CAPTURED {slug}: {len(actual.encode())} bytes", flush=True)
    finally:
        await browser.kill()
        if local_server:
            local_server.shutdown()
            local_server.server_close()
    if stale:
        raise SystemExit("STALE FIXTURES: " + ", ".join(stale))


asyncio.run(main())
