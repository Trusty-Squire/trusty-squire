#!/usr/bin/env python3
"""Read-only browser-use DOM serializer bridge for Trusty Squire.

The process accepts JSON Lines on stdin and only ever attaches to the caller's
already-running DevTools endpoint.  It deliberately exposes a very small,
structural result: browser-use decides which DOM nodes survive its serializer;
Trusty Squire applies its stricter value-safe output policy afterwards.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
from typing import Any

from browser_use.browser.session import BrowserSession
from browser_use.dom.service import DomService


async def observe(cdp_url: str) -> dict[str, Any]:
    # BrowserSession's CDP client only speaks to the supplied endpoint.  It does
    # not navigate, evaluate caller-provided source, dispatch actions, or enable
    # browser-use telemetry in this bridge.
    session = BrowserSession(
        cdp_url=cdp_url,
        keep_alive=False,
        highlight_elements=False,
        dom_highlight_elements=False,
        paint_order_filtering=True,
        cross_origin_iframes=True,
    )
    await session.start()
    try:
        dom = DomService(
            session,
            logger=logging.getLogger("trusty-squire.browser-use"),
            cross_origin_iframes=True,
            paint_order_filtering=True,
            viewport_threshold=1000,
        )
        state, _tree, _timing = await dom.get_serialized_dom_tree()
        selected: list[dict[str, Any]] = []
        for node in state.selector_map.values():
            # These raw fields are *process-internal matching hints*.  They are
            # never logged, persisted, or returned by TS; the TS allowlist seal
            # turns matching candidates into finite enums before any sink.
            # Match browser-use's own MCP listing: descendant text first, then
            # accessible naming attributes for otherwise textless controls.
            # Deliberately never use `value` here: it can be card, credential,
            # or merchant-entered data rather than a control label.
            text = node.get_all_children_text(max_depth=2)
            if not text:
                for attribute in ("aria-label", "title", "placeholder", "alt"):
                    value = node.attributes.get(attribute)
                    if value:
                        text = value
                        break
            selected.append(
                {
                    "backend_node_id": node.backend_node_id,
                    "tag": node.tag_name,
                    "role": node.ax_node.role if node.ax_node else None,
                    "name": text[:160],
                }
            )
        return {"ok": True, "selected": selected}
    finally:
        await session.stop()


async def main() -> None:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if request.get("kind") != "observe" or not isinstance(request.get("cdp_url"), str):
                raise ValueError("invalid request")
            result = await observe(request["cdp_url"])
        except Exception as exc:  # availability is a feature-flagged fallback, never an action failure
            result = {"ok": False, "error": type(exc).__name__}
        sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    asyncio.run(main())
