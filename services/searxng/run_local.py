import os

ROOT = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("SEARXNG_SETTINGS_PATH", os.path.join(ROOT, "settings.local.yml"))

from searx import settings  # noqa: E402
from searx.webapp import app  # noqa: E402

if __name__ == "__main__":
    app.run(
        host=settings["server"].get("bind_address", "127.0.0.1"),
        port=int(settings["server"].get("port", 18999)),
        debug=False,
        use_reloader=False,
    )
