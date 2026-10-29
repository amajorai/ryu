#!/usr/bin/env python3
"""Ryu playground web server for GitHub Codespaces.

Serves the playground webapp bundle and forwards Core's API paths to the
codespace's own Ryu Core, on one loopback origin:

    python3 -I playground-web.py --root DIR --token-file FILE \
        [--listen 127.0.0.1:7990] [--upstream 127.0.0.1:7980] \
        [--allowed-host HOST[:PORT]]...

Codespaces forwards the listen port privately to the codespace owner's
browser. The browser never holds Core's token: this server adds it to every
forwarded request, so the page works as Core's single local owner.

Forwarded requests are piped as raw bytes in both directions, so streamed
responses (server-sent events, chunked bodies) and WebSocket upgrades pass
through unbuffered. Requests are accepted only for an allowed Host (loopback
by default, plus any --allowed-host such as the Codespaces forwarding name), so
DNS rebinding cannot reach Core with the owner token; Core paths also refuse
cross-site browser requests (a foreign Origin or Sec-Fetch-Site: cross-site).
Each forwarded request gets its own upstream connection
(`Connection: close`), so every request's headers are rewritten here.

Standard library only (Python 3.8+); nothing to install.
"""

from __future__ import annotations

import argparse
import asyncio
import mimetypes
import os
import posixpath
import signal
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

# Core's HTTP surface. Everything else is the static bundle.
CORE_PREFIXES = ("/api", "/v1", "/mcp", "/ws", "/health", "/heartbeat", "/workflows")

# Request headers never passed to Core: hop-by-hop headers, the caller's own
# credentials and browser context, and forwarding metadata. Core sees a plain
# loopback request from its owner.
DROP_REQUEST_HEADERS = frozenset(
    {
        "authorization",
        "connection",
        "cookie",
        "forwarded",
        "host",
        "keep-alive",
        "origin",
        "proxy-authorization",
        "proxy-connection",
        "referer",
        "te",
        "trailer",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-port",
        "x-forwarded-proto",
        "x-real-ip",
    }
)

MAX_HEAD_BYTES = 64 * 1024
PIPE_CHUNK = 64 * 1024
COMPRESSIBLE_SUFFIXES = (".css", ".html", ".js", ".json", ".mjs", ".svg", ".txt", ".wasm")


class BadRequest(Exception):
    """The client sent a request this server will not parse."""


def is_core_path(path: str) -> bool:
    return any(path == prefix or path.startswith(prefix + "/") for prefix in CORE_PREFIXES)


def parse_head(raw: bytes) -> tuple[str, str, str, list[tuple[str, str]]]:
    try:
        text = raw.decode("latin-1")
    except UnicodeDecodeError as error:  # pragma: no cover - latin-1 decodes all bytes
        raise BadRequest("undecodable request head") from error
    lines = text.split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) != 3 or not parts[2].startswith("HTTP/1."):
        raise BadRequest("malformed request line")
    method, target, version = parts
    if not target.startswith("/"):
        raise BadRequest("only origin-form request targets are accepted")
    headers: list[tuple[str, str]] = []
    for line in lines[1:]:
        if not line:
            continue
        name, sep, value = line.partition(":")
        if not sep or not name or name != name.strip():
            raise BadRequest("malformed header")
        headers.append((name, value.strip()))
    return method, target, version, headers


def header(headers: list[tuple[str, str]], name: str) -> str:
    for key, value in headers:
        if key.lower() == name:
            return value
    return ""


class PlaygroundServer:
    def __init__(
        self,
        root: Path,
        token_file: Path,
        upstream_host: str,
        upstream_port: int,
        allowed_hosts: frozenset[str] = frozenset(),
    ):
        self.allowed_hosts = frozenset(host.lower() for host in allowed_hosts)
        self.root = root.resolve()
        self.token_file = token_file
        self.upstream_host = upstream_host
        self.upstream_port = upstream_port

    def host_allowed(self, headers: list[tuple[str, str]]) -> bool:
        return header(headers, "host").lower() in self.allowed_hosts

    def origin_allowed(self, headers: list[tuple[str, str]]) -> bool:
        """Refuse cross-site browser callers before the owner token is added."""
        if header(headers, "sec-fetch-site").lower() == "cross-site":
            return False
        origin = header(headers, "origin")
        if not origin:
            return True
        scheme, sep, host = origin.lower().partition("://")
        return bool(sep) and scheme in ("http", "https") and host in self.allowed_hosts

    def token(self) -> str:
        # Read per request: a restarted codespace keeps the file, and a rotated
        # token takes effect without restarting this server.
        return self.token_file.read_text(encoding="utf-8").strip()

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            try:
                raw = await reader.readuntil(b"\r\n\r\n")
            except asyncio.LimitOverrunError:
                await self.respond(writer, 431, b"Request header fields too large\n")
                return
            except asyncio.IncompleteReadError:
                return
            try:
                method, target, version, headers = parse_head(raw[:-4])
            except BadRequest as error:
                await self.respond(writer, 400, f"{error}\n".encode())
                return
            if not self.host_allowed(headers):
                await self.respond(writer, 403, b"Host not allowed\n")
                return
            path = urlsplit(target).path
            if is_core_path(path):
                if not self.origin_allowed(headers):
                    await self.respond(writer, 403, b"Cross-site requests are not allowed\n")
                    return
                await self.forward(reader, writer, method, target, headers)
            else:
                await self.serve_static(writer, method, path, headers)
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    async def forward(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        method: str,
        target: str,
        headers: list[tuple[str, str]],
    ) -> None:
        try:
            token = self.token()
        except OSError:
            await self.respond(writer, 503, b"Ryu Core token is not available yet\n")
            return
        upgrade = header(headers, "upgrade")
        connection_tokens = {t.strip().lower() for t in header(headers, "connection").split(",")}
        is_upgrade = bool(upgrade) and "upgrade" in connection_tokens
        lines = [f"{method} {target} HTTP/1.1", f"Host: {self.upstream_host}:{self.upstream_port}"]
        for name, value in headers:
            lowered = name.lower()
            if lowered in DROP_REQUEST_HEADERS or (lowered == "upgrade" and not is_upgrade):
                continue
            lines.append(f"{name}: {value}")
        lines.append(f"Authorization: Bearer {token}")
        lines.append("Connection: Upgrade" if is_upgrade else "Connection: close")
        head = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1")
        try:
            up_reader, up_writer = await asyncio.open_connection(self.upstream_host, self.upstream_port)
        except OSError:
            await self.respond(writer, 502, b"Ryu Core is not reachable yet; it may still be starting\n")
            return
        try:
            up_writer.write(head)
            await up_writer.drain()
            # The request body (fixed-length or chunked) and, after an upgrade,
            # WebSocket frames flow upstream; the response flows back unbuffered.
            # The exchange ends when Core closes its side.
            to_core = asyncio.ensure_future(self.pipe(reader, up_writer))
            await self.pipe(up_reader, writer)
            to_core.cancel()
        finally:
            up_writer.close()
            try:
                await up_writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    @staticmethod
    async def pipe(source: asyncio.StreamReader, sink: asyncio.StreamWriter) -> None:
        try:
            while True:
                chunk = await source.read(PIPE_CHUNK)
                if not chunk:
                    break
                sink.write(chunk)
                await sink.drain()
        except (ConnectionError, OSError):
            pass

    def resolve_static(self, path: str) -> Path | None:
        clean = posixpath.normpath(unquote(path))
        if "\x00" in clean:
            return None
        candidate = (self.root / clean.lstrip("/")).resolve()
        if candidate != self.root and self.root not in candidate.parents:
            return None
        if candidate.is_dir():
            candidate = candidate / "index.html"
        if candidate.is_file():
            return candidate
        # Hashed assets that are missing are real 404s; every other path is a
        # client-side route and gets the app shell.
        if clean.startswith("/assets/") or posixpath.splitext(clean)[1] not in ("", ".html"):
            return None
        return self.root / "index.html"

    async def serve_static(
        self,
        writer: asyncio.StreamWriter,
        method: str,
        path: str,
        headers: list[tuple[str, str]],
    ) -> None:
        if method not in ("GET", "HEAD"):
            await self.respond(writer, 405, b"Method not allowed\n", extra=[("Allow", "GET, HEAD")])
            return
        file = self.resolve_static(path)
        if file is None:
            await self.respond(writer, 404, b"Not found\n")
            return
        content_type = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in ("application/javascript", "image/svg+xml"):
            content_type += "; charset=utf-8"
        extra = [("Content-Type", content_type), ("X-Content-Type-Options", "nosniff")]
        if file.parent.name == "assets":
            extra.append(("Cache-Control", "public, max-age=31536000, immutable"))
        else:
            extra.append(("Cache-Control", "no-cache"))
        body_file = file
        gzipped = file.with_name(file.name + ".gz")
        if (
            file.suffix in COMPRESSIBLE_SUFFIXES
            and "gzip" in header(headers, "accept-encoding").lower()
            and gzipped.is_file()
        ):
            body_file = gzipped
            extra.append(("Content-Encoding", "gzip"))
        if file.suffix in COMPRESSIBLE_SUFFIXES:
            extra.append(("Vary", "Accept-Encoding"))
        body = body_file.read_bytes()
        await self.respond(writer, 200, b"" if method == "HEAD" else body, extra=extra, length=len(body))

    @staticmethod
    async def respond(
        writer: asyncio.StreamWriter,
        status: int,
        body: bytes,
        extra: list[tuple[str, str]] | None = None,
        length: int | None = None,
    ) -> None:
        reasons = {
            200: "OK",
            400: "Bad Request",
            403: "Forbidden",
            404: "Not Found",
            405: "Method Not Allowed",
            431: "Request Header Fields Too Large",
            502: "Bad Gateway",
            503: "Service Unavailable",
        }
        lines = [f"HTTP/1.1 {status} {reasons.get(status, 'Error')}"]
        names = {name.lower() for name, _ in extra or []}
        if "content-type" not in names:
            lines.append("Content-Type: text/plain; charset=utf-8")
        for name, value in extra or []:
            lines.append(f"{name}: {value}")
        lines.append(f"Content-Length: {len(body) if length is None else length}")
        lines.append("Connection: close")
        writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body)
        await writer.drain()


def split_host_port(value: str) -> tuple[str, int]:
    host, sep, port = value.rpartition(":")
    if not sep or not host or not port.isdigit():
        raise argparse.ArgumentTypeError(f"expected HOST:PORT, got {value!r}")
    return host, int(port)


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", required=True, type=Path, help="extracted webapp bundle")
    parser.add_argument("--token-file", required=True, type=Path, help="file holding Core's token")
    parser.add_argument("--listen", default="127.0.0.1:7990", type=split_host_port)
    parser.add_argument("--upstream", default="127.0.0.1:7980", type=split_host_port)
    parser.add_argument(
        "--allowed-host",
        action="append",
        default=[],
        metavar="HOST[:PORT]",
        help="extra Host header value to accept (repeatable), e.g. the Codespaces forwarding name",
    )
    args = parser.parse_args()
    if not (args.root / "index.html").is_file():
        print(f"error: {args.root} has no index.html", file=sys.stderr)
        return 1
    for suffix, kind in ((".js", "application/javascript"), (".mjs", "application/javascript"), (".wasm", "application/wasm")):
        mimetypes.add_type(kind, suffix)
    upstream_host, upstream_port = args.upstream
    listen_host, listen_port = args.listen
    allowed_hosts = {f"127.0.0.1:{listen_port}", f"localhost:{listen_port}", f"[::1]:{listen_port}"}
    allowed_hosts.update(host.strip() for host in args.allowed_host if host.strip())
    server = PlaygroundServer(args.root, args.token_file, upstream_host, upstream_port, frozenset(allowed_hosts))
    listener = await asyncio.start_server(server.handle, listen_host, listen_port, limit=MAX_HEAD_BYTES)
    print(f"Ryu playground web UI on http://{listen_host}:{listen_port} -> Core at {upstream_host}:{upstream_port}", flush=True)
    stop = asyncio.get_running_loop().create_future()
    for signum in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(signum, lambda: stop.done() or stop.set_result(None))
    async with listener:
        await stop
    return 0


if __name__ == "__main__":
    os.umask(0o077)
    sys.exit(asyncio.run(main()))
