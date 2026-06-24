"""Ryu Unsloth sidecar — a Core-managed Python fine-tuning runtime.

This process wraps the Apache-2.0 `unsloth` library (+ TRL's `SFTTrainer`) behind
one small HTTP contract so Ryu Core can drive LoRA/QLoRA fine-tuning the same way
it drives whisper.cpp, stable-diffusion.cpp, and the TTS sidecar: Core owns
lifecycle, persistence, routing, and the desktop UI; this is a pure training
runtime. We deliberately use the **library**, not Unsloth's AGPL-3.0 Studio UI.
"""

from __future__ import annotations

__version__ = "0.1.0"

# Default HTTP port. Core pins it at spawn via RYU_UNSLOTH_PORT. Chosen to sit
# above the other local runtimes (llamacpp 8080, embed 8081, mlx 8082, sdcpp
# 8083, mlx-vlm 8084, ryutts 8085).
DEFAULT_PORT = 8086
