# Operate live share and Beeline proxy contract

`operate_share({session_id})` returns `{url, expires_at, control}` for an active
operate session. The URL is a bearer capability for **that session's current
page only**, following a tab handoff when the session adopts a new page. It is
not a VNC or shared-display address. Repeating the call while
the share is active returns the same URL, renews `expires_at`, and returns current
`control` (`agent` or `human`). The ten-minute compatibility expiry rolls forward
automatically while the operate session is alive; clients must not close the
share when a previously returned `expires_at` passes.
Clients may repeat `operate_share` before their returned expiry to refresh that
timestamp without replacing the link. `operate_finish`, broker disconnect,
forced session close/reaping, or an explicit share stop invalidates the URL.
A later `operate_share` can create a fresh share while the session remains active.

The broker prepares one loopback HTTP gateway and `cloudflared` quick tunnel
when it starts. The gateway routes each bearer-token path to its own share;
opening a fresh share therefore does not wait for a new tunnel URL. Browser
frames start when a viewer connects and do not delay `operate_share`'s result.
If gateway preparation fails, the next share retries it and reports the error
if the retry fails. The broker closes the gateway when it shuts down.
The agent receives the upstream URL in the tool result and must pass it only to
a trusted server-side proxy. The live JPEG stream is raw page pixels; it does
not use the released-card mask applied to `operate_screenshot`. Anyone able to
open the bearer URL can see those pixels, including visible card fields. A
fresh 256-bit token appears as `/s/<token>/` in the upstream URL. Beeline must
keep this upstream URL and token on its server. Its card and "Open in browser"
action should both link to Beeline's own `https://computer.usebeeline.app/s/<id>/`
URL; neither the browser HTML nor any user-visible redirect should reveal the
upstream host or token. Treat the upstream URL like a password: do not log it,
include it in analytics, or send it to another client. The tunnel and token
provide access without a separate security prompt.

Proxy these paths, preserving `GET`, WebSocket Upgrade, and bidirectional
WebSocket frames:

| Beeline path | Upstream path | Purpose |
| --- | --- | --- |
| `/s/<id>/` | `/s/<token>/` | Viewer HTML (`text/html`, no-store) |
| `/s/<id>/stream` | `/s/<token>/stream` | WebSocket frames and input |

The viewer HTML uses a relative `stream` URL, so the Beeline path must end in
`/`. There is no cookie, query parameter, or extra authorization header on the
upstream. The token is the whole upstream authorization. A bad or stopped token
returns 404; existing viewer connections close when a share stops. Beeline should close
the upstream WebSocket when its viewer leaves the artifact or browser tab.
Multiple viewers may watch the same link, including an embedded viewer and a
system browser.

The WebSocket sends JSON text messages:

- Server to viewer: `{ "type": "frame", "data": "<base64 JPEG>" }`,
  `{ "type": "blank" }` while the session switches pages,
  `{ "type": "control", "state": "agent" | "human" }`, and
  `{ "type": "navigation", "url": "<current main-frame URL>", "origin": "<URL origin>" }`.
- Viewer to server: `{ "type": "pointer", "phase": "down" | "move" | "up", "x": 0..1, "y": 0..1, "button": "left" | "middle" | "right" }`,
  `{ "type": "touch", "phase": "start" | "move" | "end", "x": 0..1, "y": 0..1 }`,
  `{ "type": "wheel", "x": 0..1, "y": 0..1, "delta_x": number, "delta_y": number }`,
  `{ "type": "text", "text": "..." }`, or
  `{ "type": "key", "key": "Backspace" | "Tab" | "Enter" | "Escape" | "ArrowLeft" | "ArrowUp" | "ArrowRight" | "ArrowDown" | "Delete" | "a".."z", "ctrl"?: boolean, "meta"?: boolean, "alt"?: boolean, "shift"?: boolean }`.

Coordinates are fractions of the rendered JPEG's width and height. The first
valid input claims control, pauses agent browser actions, and broadcasts
`control: human`. If another viewer sends input, it becomes the controller.
When that controlling viewer's WebSocket disconnects, the broker broadcasts
`control: agent` and allows waiting agent actions to resume. A long
`operate_drive` yields at each step so a viewer can take over between actions.
Read-only observations continue during human control. The broker streams and
dispatches only through the operate session's Playwright page CDP session.
Chromium can withhold screencast frames from a background tab, so the broker
captures fallback frames from that same CDP target without activating it;
other tabs and the host display never enter this transport.

Navigation messages report the current page when a viewer joins an active stream,
when streaming starts or switches pages, and every main-frame navigation,
including same-document history/hash changes. Subframe navigations and the
previously shared page after a tab handoff do not emit navigation messages.
An outbound WebSocket queue of 1,000,000 bytes or more causes new frames to be
dropped for that viewer; navigation and other metadata are still
sent to every open viewer. These URL/origin fields use the session's narrow
released-card value mask; the frame pixels remain raw as described above.
