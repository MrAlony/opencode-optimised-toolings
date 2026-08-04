$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:SEARXNG_SETTINGS_PATH = Join-Path $root "settings.yml"
& (Join-Path $root ".venv\Scripts\python.exe") (Join-Path $root "run_local.py")
