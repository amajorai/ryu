"""Entry point: `python -m ryu_tts` starts the uvicorn server.

Host/port are overridable via env so Core can pin them at spawn time:
  RYU_TTS_HOST (default 127.0.0.1) · RYU_TTS_PORT (default 8085)
"""

from __future__ import annotations

import os

import uvicorn

from . import DEFAULT_PORT


def main() -> None:
    host = os.environ.get("RYU_TTS_HOST", "127.0.0.1")
    port = int(os.environ.get("RYU_TTS_PORT", str(DEFAULT_PORT)))
    uvicorn.run("ryu_tts.server:app", host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
