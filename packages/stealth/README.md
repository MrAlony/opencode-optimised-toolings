# Native stealth tooling

This package exposes `alonix-stealth-fetch-many`, `alonix-stealth-search-many`, `alonix-stealth-rotate-tor`, and `alonix-stealth-status` through an in-process Node.js runtime. It is not an MCP server and has no Python environment or manually started service.

Tor uses dedicated loopback SOCKS/control ports, cookie authentication, bounded bootstrap, and owned-process cleanup. A configured trusted Tor executable or PATH installation is used when available; otherwise the matching official Tor expert bundle is downloaded lazily into the user-owned Alonix runtime and accepted only after its pinned SHA-256 matches.

Patchright HTTP is used for lightweight requests. Chromium is launched only for JavaScript-rendered requests and is installed lazily through Patchright when absent. Status checks never provision heavyweight assets.
