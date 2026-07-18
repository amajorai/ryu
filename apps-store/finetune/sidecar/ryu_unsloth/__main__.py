"""Entry point: `python -m ryu_unsloth` starts the uvicorn server.

Host/port are overridable via env so Core can pin them at spawn time:
  RYU_UNSLOTH_HOST (default 127.0.0.1) · RYU_UNSLOTH_PORT (default 8086)
"""

from __future__ import annotations

import os

import uvicorn

from . import DEFAULT_PORT


def main() -> None:
    host = os.environ.get("RYU_UNSLOTH_HOST", "127.0.0.1")
    port = int(os.environ.get("RYU_UNSLOTH_PORT", str(DEFAULT_PORT)))
    # Single worker on purpose: training jobs hold GPU/model state in-process.
    uvicorn.run("ryu_unsloth.server:app", host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
