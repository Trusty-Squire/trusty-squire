#!/usr/bin/env python3
"""Loopback vault for the no-systemd container fixture. Not a real account."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 18765


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/v1/vault/credentials":
            body = b'{"credentials":[]}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
