from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup
from markdownify import markdownify

RUNTIME = Path(os.environ.get("OPENCODE_STEALTH_RUNTIME", Path(__file__).parent / "runtime")).resolve()
DATA_DIR = RUNTIME / "tor-data"
COOKIE = RUNTIME / "control_auth_cookie"
TORRC = RUNTIME / "torrc"
SOCKS_PORT = int(os.environ.get("OPENCODE_TOR_SOCKS_PORT", "19050"))
CONTROL_PORT = int(os.environ.get("OPENCODE_TOR_CONTROL_PORT", "19051"))
TOR_EXECUTABLE = os.environ.get("OPENCODE_TOR_EXECUTABLE", "") or shutil.which("tor") or ""
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
MAX_ITEM_BYTES = 2 * 1024 * 1024
_tor_process: subprocess.Popen | None = None
_tor_log_handle = None
_playwright = None
_browser = None
_context = None
_browser_lock = asyncio.Lock()
_last_newnym = 0.0


def port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5): return True
    except OSError: return False


def validate_url(value: str, allow_private: bool = False) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname: raise ValueError("A fully formed HTTP or HTTPS URL is required.")
    if parsed.username or parsed.password: raise ValueError("Credentials embedded in URLs are not allowed.")
    hostname = parsed.hostname.lower().rstrip(".")
    blocked_names = {"localhost", "localhost.localdomain", "metadata", "metadata.google.internal", "instance-data", "169.254.169.254.nip.io"}
    if not allow_private and (hostname in blocked_names or hostname.endswith((".localhost", ".local", ".internal"))): raise ValueError("Private, local, and metadata destinations are blocked by default.")
    try: address = ipaddress.ip_address(hostname.split("%", 1)[0])
    except ValueError: address = None
    if address is not None and not allow_private and not address.is_global: raise ValueError(f"Non-public IP destination {address} is blocked by default.")
    # Public hostnames deliberately are not resolved here: SOCKS performs remote
    # DNS so the privacy tool does not leak destination lookups outside Tor.
    return value


def torrc_text() -> str:
    return "\n".join([f"SocksPort 127.0.0.1:{SOCKS_PORT}", f"ControlPort 127.0.0.1:{CONTROL_PORT}", f"DataDirectory {DATA_DIR.as_posix()}", "CookieAuthentication 1", f"CookieAuthFile {COOKIE.as_posix()}", "ClientOnly 1", "AvoidDiskWrites 1", "Log notice stdout", ""])


def control(command: str, timeout: float = 8.0) -> str:
    if not COOKIE.exists(): raise RuntimeError("Tor control cookie is unavailable.")
    auth = COOKIE.read_bytes().hex()
    with socket.create_connection(("127.0.0.1", CONTROL_PORT), timeout=timeout) as connection:
        stream = connection.makefile("rwb", buffering=0)
        stream.write(f'AUTHENTICATE {auth}\r\n'.encode())
        response = stream.readline().decode(errors="replace").strip()
        if not response.startswith("250"): raise RuntimeError(f"Tor cookie authentication failed: {response}")
        stream.write(f"{command}\r\n".encode())
        lines = []
        while True:
            line = stream.readline().decode(errors="replace").strip()
            if not line: break
            lines.append(line)
            if line == "250 OK" or line.startswith("5"): break
        text = "\n".join(lines)
        if any(line.startswith("5") for line in lines): raise RuntimeError(f"Tor control command failed: {text}")
        return text


def tor_state() -> dict[str, Any]:
    bootstrapped = False
    authenticated = False
    detail = ""
    if port_open(CONTROL_PORT) and COOKIE.exists():
        try:
            detail = control("GETINFO status/bootstrap-phase")
            authenticated = True
            bootstrapped = "PROGRESS=100" in detail or "TAG=done" in detail
        except Exception as exc: detail = str(exc)
    return {"owned": bool(_tor_process and _tor_process.poll() is None), "bootstrapped": bootstrapped, "authenticated": authenticated, "socks_port": SOCKS_PORT, "control_port": CONTROL_PORT, "detail": detail}


def ensure_tor() -> dict[str, Any]:
    global _tor_process, _tor_log_handle
    state = tor_state()
    if state["bootstrapped"] and port_open(SOCKS_PORT): return state
    if not TOR_EXECUTABLE or not Path(TOR_EXECUTABLE).exists(): raise RuntimeError("Tor executable is not configured or could not be found. Add it to config/secrets.local.json or PATH.")
    if port_open(SOCKS_PORT) or port_open(CONTROL_PORT): raise RuntimeError("Dedicated stealth Tor ports are occupied by an unverifiable process; refusing to take ownership.")
    RUNTIME.mkdir(parents=True, exist_ok=True); DATA_DIR.mkdir(parents=True, exist_ok=True); TORRC.write_text(torrc_text(), encoding="utf-8")
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    log_path = RUNTIME / "tor.log"
    _tor_log_handle = open(log_path, "w", encoding="utf-8")
    _tor_process = subprocess.Popen([TOR_EXECUTABLE, "-f", str(TORRC)], cwd=RUNTIME, stdout=_tor_log_handle, stderr=subprocess.STDOUT, creationflags=flags)
    deadline = time.time() + 75
    while time.time() < deadline:
        if _tor_process.poll() is not None:
            _tor_log_handle.flush()
            detail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
            raise RuntimeError(f"Tor exited during bootstrap with code {_tor_process.returncode}.\n{detail}")
        state = tor_state()
        if state["bootstrapped"] and port_open(SOCKS_PORT): return state
        time.sleep(1)
    _tor_log_handle.flush()
    detail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
    raise RuntimeError(f"Tor did not complete bootstrap within 75 seconds.\n{detail}")


async def ensure_browser():
    global _playwright, _browser, _context
    async with _browser_lock:
        if _context is not None: return _context
        ensure_tor()
        from patchright.async_api import async_playwright
        _playwright = await async_playwright().start()
        _browser = await _playwright.chromium.launch(headless=True, proxy={"server": f"socks5://127.0.0.1:{SOCKS_PORT}"})
        _context = await _browser.new_context(user_agent=UA)
        return _context


async def close_browser():
    global _playwright, _browser, _context
    async with _browser_lock:
        for value in (_context, _browser, _playwright):
            if value is not None:
                try: await value.close() if value is not _playwright else await value.stop()
                except Exception: pass
        _context = _browser = _playwright = None


def converted(html: str, text: str, fmt: str) -> str:
    if fmt == "html": return html
    if fmt == "text": return text
    return markdownify(html, heading_style="ATX")


async def fetch_item(spec: dict[str, Any]) -> dict[str, Any]:
    raw_url = str(spec.get("url", ""))
    timeout_ms = max(1000, min(int(spec.get("timeout_ms") or 60000), 120000))
    fmt = str(spec.get("format") or "markdown")
    try:
        url = validate_url(raw_url, bool(spec.get("allow_private", False)))
        if spec.get("render_js", True):
            context = await ensure_browser(); page = await context.new_page()
            try:
                response = await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                wait_for = spec.get("wait_for")
                if wait_for:
                    if str(wait_for).isdigit(): await page.wait_for_timeout(min(int(wait_for), 30000))
                    else: await page.wait_for_selector(str(wait_for), timeout=min(timeout_ms, 30000))
                selector = spec.get("selector")
                node = page.locator(selector).first if selector else page.locator("body")
                if await node.count() == 0: raise ValueError(f"CSS selector was not found: {selector}")
                html = await node.inner_html(); text = await node.inner_text()
                content = converted(html, text, fmt)
                return {"ok": True, "url": url, "final_url": page.url, "status": response.status if response else 0, "title": await page.title(), "content": content[:MAX_ITEM_BYTES], "source_truncated": len(content.encode()) > MAX_ITEM_BYTES}
            finally: await page.close()
        import httpx
        ensure_tor()
        async with httpx.AsyncClient(proxy=f"socks5://127.0.0.1:{SOCKS_PORT}", follow_redirects=True, timeout=timeout_ms / 1000, headers={"User-Agent": UA}) as client:
            response = await client.get(url); response.raise_for_status(); html = response.text
        soup = BeautifulSoup(html, "html.parser")
        node = soup.select_one(str(spec.get("selector"))) if spec.get("selector") else soup
        if node is None: raise ValueError(f"CSS selector was not found: {spec.get('selector')}")
        content = converted(str(node), node.get_text("\n"), fmt)
        return {"ok": True, "url": url, "final_url": str(response.url), "status": response.status_code, "title": soup.title.get_text(strip=True) if soup.title else "", "content": content[:MAX_ITEM_BYTES], "source_truncated": len(content.encode()) > MAX_ITEM_BYTES}
    except Exception as exc: return {"ok": False, "url": raw_url, "error": str(exc), "content": ""}


async def search_item(spec: dict[str, Any]) -> dict[str, Any]:
    query = str(spec.get("query", "")).strip(); maximum = max(1, min(int(spec.get("max_results") or 10), 20))
    if not query: return {"ok": False, "query": query, "error": "Query must not be empty.", "content": ""}
    try:
        import httpx
        ensure_tor(); url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query)
        async with httpx.AsyncClient(proxy=f"socks5://127.0.0.1:{SOCKS_PORT}", follow_redirects=True, timeout=60, headers={"User-Agent": UA}) as client:
            response = await client.get(url); response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser"); rows = []
        for link in soup.select("a.result__a"):
            href = link.get("href", "")
            if "y.js" in href or "ad_provider=" in href: continue
            parsed = urllib.parse.urlparse(href); actual = urllib.parse.parse_qs(parsed.query).get("uddg", [href])[0]
            parent = link.find_parent("div", class_="result") or link.parent; snippet = parent.select_one(".result__snippet") if parent else None
            rows.append(f"{len(rows)+1}. {link.get_text(strip=True)}\n   {actual}\n   {snippet.get_text(strip=True) if snippet else ''}")
            if len(rows) >= maximum: break
        return {"ok": True, "query": query, "content": "\n\n".join(rows) or "No results found (DuckDuckGo may have challenged the request)."}
    except Exception as exc: return {"ok": False, "query": query, "error": str(exc), "content": ""}


async def bounded_map(items, concurrency, worker):
    semaphore = asyncio.Semaphore(max(1, min(int(concurrency or 3), 4)))
    async def run(item):
        async with semaphore: return await worker(item)
    return await asyncio.gather(*(run(item) for item in items))


async def handle(action: str, payload: dict[str, Any]) -> Any:
    global _last_newnym
    if action == "status":
        state = tor_state(); return {"ready": bool(TOR_EXECUTABLE), "worker": True, "tor_executable": TOR_EXECUTABLE, "tor": state, "browser": _context is not None, "detail": state.get("detail", "")}
    if action == "fetch_many": return {"items": await bounded_map(payload.get("requests", []), payload.get("max_concurrency", 3), fetch_item), "tor": tor_state()}
    if action == "search_many": return {"items": await bounded_map(payload.get("queries", []), payload.get("max_concurrency", 3), search_item), "tor": tor_state()}
    if action == "rotate":
        ensure_tor(); wait = max(0.0, 10.0 - (time.time() - _last_newnym))
        if wait: await asyncio.sleep(wait)
        response = await asyncio.to_thread(control, "SIGNAL NEWNYM"); _last_newnym = time.time(); await close_browser()
        return {"message": response or "Tor accepted NEWNYM.", "waited_seconds": round(wait, 2), "browser_rebuilt": True}
    if action == "shutdown": await shutdown(); return {"stopped": True}
    raise ValueError(f"Unknown worker action: {action}")


async def shutdown():
    global _tor_process, _tor_log_handle
    await close_browser()
    if _tor_process and _tor_process.poll() is None:
        try: control("SIGNAL SHUTDOWN")
        except Exception: _tor_process.terminate()
        try: _tor_process.wait(timeout=8)
        except subprocess.TimeoutExpired: _tor_process.kill()
    _tor_process = None
    if _tor_log_handle:
        try: _tor_log_handle.close()
        except Exception: pass
    _tor_log_handle = None


async def main():
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line: break
        message = None
        try:
            message = json.loads(line); result = await handle(message.get("action", ""), message.get("payload") or {})
            print(json.dumps({"id": message.get("id"), "ok": True, "result": result}, ensure_ascii=False), flush=True)
            if message.get("action") == "shutdown": break
        except Exception as exc: print(json.dumps({"id": message.get("id") if message else None, "ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)
    await shutdown()


if __name__ == "__main__": asyncio.run(main())
