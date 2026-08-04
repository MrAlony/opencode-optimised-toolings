# Native stealth tooling

This package exposes native OpenCode tools (`stealth_fetch_many`, `stealth_search_many`, `stealth_rotate_tor`, `stealth_status`) through a supervised Python JSON-lines worker. It is not an MCP server.

The worker owns only the dedicated Tor process it starts, authenticates the control protocol with Tor's generated cookie, uses dedicated loopback ports from `config/secrets.local.json`, waits for bootstrap, bounds page concurrency and content, and closes browser/Tor resources when OpenCode disposes the plugin.

Run the repository setup command to create `.venv`, install requirements, and install Patchright Chromium. Configure a Tor executable in ignored local secrets or place `tor` on `PATH`.
