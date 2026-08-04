# Tor runtime prerequisite

The stealth package uses a dedicated Tor process and does not share or terminate arbitrary system Tor instances. Put a portable Tor executable at `services/tor/bin/tor` (`tor.exe` on Windows), add `tor` to `PATH`, or set `stealth.tor_executable` in ignored `config/secrets.local.json`.

Runtime `torrc`, cookie, process data, and cache are generated under `packages/stealth/runtime/` and excluded from version control. Control access uses `CookieAuthentication 1` on a loopback-only dedicated port.
