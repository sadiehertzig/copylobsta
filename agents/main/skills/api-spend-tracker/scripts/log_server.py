#!/usr/bin/env python3
"""
Lightweight HTTP server for non-Python services to log API usage.
Listens on localhost:9147. POST JSON to /log to record a usage entry.

Usage from Node.js / curl:
    curl -X POST http://localhost:9147/log -H 'Content-Type: application/json' \
      -d '{"provider":"openai","api_key_label":"trivia-voice","model":"gpt-4o-realtime-preview","input_tokens":5000,"output_tokens":2000}'

Run: python3 log_server.py
"""

import json
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from usage_logger import log_usage

PORT = int(os.environ.get("SPEND_TRACKER_PORT", 9147))


MAX_BODY = 65_536  # 64 KB


def _clamp_tokens(val, ceiling=10_000_000):
    try:
        return max(0, min(int(val), ceiling))
    except (TypeError, ValueError):
        return 0


class LogHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/log":
            self.send_error(404)
            return
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > MAX_BODY:
            self.send_response(413)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": "payload too large"}).encode())
            return
        try:
            body = json.loads(self.rfile.read(content_length))
            cost = log_usage(
                provider=body["provider"],
                api_key_label=body["api_key_label"],
                model=body["model"],
                input_tokens=_clamp_tokens(body.get("input_tokens", 0)),
                output_tokens=_clamp_tokens(body.get("output_tokens", 0)),
                cache_read_tokens=_clamp_tokens(body.get("cache_read_tokens", 0)),
                cache_write_tokens=_clamp_tokens(body.get("cache_write_tokens", 0)),
                metadata=body.get("metadata"),
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "cost_usd": cost}).encode())
        except (KeyError, json.JSONDecodeError, ValueError, TypeError) as e:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode())

    def log_message(self, format, *args):
        pass  # suppress request logs


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), LogHandler)
    print(f"Spend tracker log server listening on http://127.0.0.1:{PORT}/log")
    server.serve_forever()
