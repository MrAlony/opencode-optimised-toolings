# Local SearXNG (Windows-native)

Vendored checkout of [searxng/searxng](https://github.com/searxng/searxng) (shallow clone,
sparse: `searx/` + `requirements.txt`) running natively on Windows with a Python 3.12 venv —
no Docker/WSL required. Serves the `searxng` backend of `../oc-webtooling` (`alonix-web-search` tool).

## Run

```powershell
.\start.ps1
# or manually:
$env:SEARXNG_SETTINGS_PATH = "$PWD\settings.yml"
.\.venv\Scripts\python.exe run_local.py
```

Serves http://127.0.0.1:18999 with the JSON API enabled
(`search.formats: [html, json]`, limiter off, no Valkey/Redis needed).

Test:

```powershell
(New-Object System.Net.WebClient).DownloadString("http://127.0.0.1:18999/search?q=test&format=json")
```

## Local modifications to upstream

- `searx/valkeydb.py`: guarded `import pwd` (Unix-only) so the module imports on Windows;
  only affects an error-logging path.
- Sparse checkout skips `utils/` (it contains `searxng.conf:socket`, an invalid NTFS path
  that breaks a full checkout on Windows).

## Reinstall dependencies

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```
